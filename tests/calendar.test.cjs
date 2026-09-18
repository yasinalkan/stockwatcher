// Run with: node --test tests/calendar.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const script = html.slice(html.indexOf('/* ---------- market calendar: verified'), html.indexOf('/** Attach a directional flash'));
const context = vm.createContext({ Intl, Date, URLSearchParams, load: (_, fallback) => fallback });
vm.runInContext(script + '\nthis.api = { CAL_EVENTS, calShiftDate, calInstant, calTime, calDisplayDate, calDateInZone, calMatches, calUpcomingEvents, calCoverage, marketStatus, calInvestingURL, CAL_INVESTING_EVENTS, calMergeInvesting };', context);
const api = context.api;
const at = (iso) => api.marketStatus(new Date(iso));

// Historical regressions are deliberate: these releases did not follow the
// usual first-Friday / once-per-month patterns in the publisher's schedule.
test('dataset retains rescheduled releases and multiple events on one date', () => {
  assert(api.CAL_EVENTS.some(e => e.date === '2026-02-11' && e.short === 'Payrolls'));
  assert.equal(api.CAL_EVENTS.filter(e => e.date.startsWith('2026-01') && e.short === 'PPI').length, 2);
  assert.equal(api.CAL_EVENTS.filter(e => e.date === '2026-04-03').length, 2);
  assert(api.CAL_EVENTS.some(e => e.date === '2026-09-30' && e.short === 'GDP'));
  assert(api.CAL_EVENTS.some(e => e.date === '2026-09-30' && e.short === 'Core PCE monthly'));
});

test('schedule rows are valid, uniquely identified and chronologically ordered', () => {
  const ids = new Set();
  let previous = '';
  for (const event of api.CAL_EVENTS) {
    assert.match(event.date, /^202[67]-\d{2}-\d{2}$/);
    assert.equal(new Date(event.date).toISOString().slice(0, 10), event.date);
    assert(event.date >= previous);
    previous = event.date;
    const id = event.date + event.title;
    assert(!ids.has(id), id);
    ids.add(id);
    assert(['economic', 'fed', 'holiday', 'early'].includes(event.type));
    assert(['BLS', 'BEA', 'Fed', 'NYSE', 'Investing.com'].includes(event.source));
  }
  assert.equal(api.CAL_EVENTS.filter(e => e.type === 'holiday').length, 20);
  assert.equal(api.CAL_EVENTS.filter(e => e.type === 'early').length, 3);
});

test('New York summer and winter releases convert to correct Türkiye time', () => {
  const summer = { date: '2026-09-11', time: '08:30' };
  const winter = { date: '2026-11-10', time: '08:30' };
  assert.equal(api.calInstant(summer).toISOString(), '2026-09-11T12:30:00.000Z');
  assert.equal(api.calInstant(winter).toISOString(), '2026-11-10T13:30:00.000Z');
  assert.equal(api.calTime(summer, 'Europe/Istanbul'), '15:30 TRT');
  assert.equal(api.calTime(winter, 'Europe/Istanbul'), '16:30 TRT');
  assert.equal(api.calTime(summer, 'America/New_York'), '08:30 ET');
});

test('DST changes use the release date, not today’s offset', () => {
  for (const [date, expected] of [['2026-03-06', '16:30 TRT'], ['2026-03-09', '15:30 TRT'], ['2026-10-30', '15:30 TRT'], ['2026-11-02', '16:30 TRT']]) {
    assert.equal(api.calTime({ date, time: '08:30' }, 'Europe/Istanbul'), expected);
  }
});

test('all-day holidays stay on their market date across time zones', () => {
  const holiday = api.CAL_EVENTS.find(e => e.date === '2026-12-25');
  assert.equal(api.calDisplayDate(holiday, 'Europe/Istanbul'), '2026-12-25');
  assert.equal(api.calTime(holiday, 'Europe/Istanbul'), 'All day · ET date');
  assert.equal(api.calDateInZone(new Date('2026-12-25T02:00:00Z'), 'America/New_York'), '2026-12-24');
});

test('date arithmetic crosses months, leap days and years correctly', () => {
  assert.equal(api.calShiftDate('2026-12-31', 1), '2027-01-01');
  assert.equal(api.calShiftDate('2026-03-01', -1), '2026-02-28');
  assert.equal(api.calShiftDate('2028-03-01', -1), '2028-02-29');
});

test('holiday filter includes early closes but excludes economic releases', () => {
  assert(api.calMatches({ type: 'early' }, 'holiday'));
  assert(api.calMatches({ type: 'holiday' }, 'holiday'));
  assert(!api.calMatches({ type: 'economic' }, 'holiday'));
});

test('upcoming events exclude elapsed timed releases and respect filters', () => {
  const upcoming = api.calUpcomingEvents(new Date('2026-09-30T12:31:00Z'), 'Europe/Istanbul', 'economic');
  assert.equal(upcoming[0].title, 'Chicago PMI (Sep)');
  assert(upcoming.every(e => api.calInstant(e) >= new Date('2026-09-30T12:31:00Z')));
  assert(upcoming.every(e => e.type === 'economic'));
  assert.equal(api.calUpcomingEvents(new Date('2028-01-01T00:00:00Z'), 'America/New_York', 'all').length, 0);
});

test('upcoming all-day holidays use the New York day at the Türkiye midnight boundary', () => {
  const upcoming = api.calUpcomingEvents(new Date('2026-12-26T00:30:00+03:00'), 'Europe/Istanbul', 'holiday');
  assert.equal(upcoming[0].date, '2026-12-25');
});

test('holidays and observed holidays override ordinary weekday session hours', () => {
  assert.equal(at('2026-07-03T15:00:00Z').open, false);
  assert.match(at('2026-07-03T15:00:00Z').txt, /Independence Day/);
  assert.equal(at('2027-12-24T15:00:00Z').open, false);
  assert.match(at('2026-11-26T15:00:00Z').txt, /Thanksgiving/);
});

test('early close switches precisely at 13:00 ET; July 2 2026 is a full session', () => {
  assert.equal(at('2026-11-27T17:59:00Z').open, true);
  assert.equal(at('2026-11-27T18:00:00Z').open, false);
  assert.match(at('2026-11-27T18:00:00Z').txt, /early close/);
  assert.equal(at('2026-12-24T17:59:00Z').open, true);
  assert.equal(at('2026-12-24T18:00:00Z').open, false);
  assert.equal(at('2026-07-02T18:00:00Z').open, true);
});

test('regular sessions, pre-market, after-hours and weekends remain correct', () => {
  assert.equal(at('2026-09-18T13:29:00Z').txt, 'Pre-market');
  assert.equal(at('2026-09-18T13:30:00Z').open, true);
  assert.equal(at('2026-09-18T20:00:00Z').txt, 'After hours');
  assert.equal(at('2026-09-19T15:00:00Z').txt, 'Weekend');
  assert.equal(at('2026-09-18T05:00:00Z').txt, 'Closed');
});

test('coverage gaps do not claim a complete calendar or a verified market session', () => {
  assert.match(api.calCoverage('2027-01'), /Economic release dates are not loaded/);
  assert.match(api.calCoverage('2028-01'), /No verified schedule/);
  assert.match(api.calCoverage('2026-05'), /September–December only/);
  assert.equal(at('2028-01-03T15:00:00Z').txt, 'Session unverified');
});


test('Investing live link is restricted to US three-star events with all value columns', () => {
  const url = new URL(api.calInvestingURL('Europe/Istanbul'));
  assert.equal(url.origin, 'https://sslecal2.investing.com');
  assert.equal(url.searchParams.get('countries'), '5');
  assert.equal(url.searchParams.get('importance'), '3');
  assert.equal(url.searchParams.get('calType'), 'week');
  assert.equal(url.searchParams.get('columns'), 'exc_flags,exc_currency,exc_importance,exc_actual,exc_forecast,exc_previous');
  assert.equal(url.searchParams.get('features'), 'datepicker,timeselector');
  assert(!url.searchParams.get('features').includes('filters'));
});

test('Investing live link uses named provider zones for Türkiye and New York', () => {
  assert.equal(new URL(api.calInvestingURL('Europe/Istanbul')).searchParams.get('timeZone'), '63');
  assert.equal(new URL(api.calInvestingURL('America/New_York')).searchParams.get('timeZone'), '8');
  assert.equal(new URL(api.calInvestingURL('invalid&countries=1')).searchParams.get('countries'), '5');
});


test('high-impact filter contains only the 56 observed US three-star releases', () => {
  const high = api.CAL_EVENTS.filter(e => api.calMatches(e, 'high'));
  assert.equal(high.length, 56);
  assert(high.every(e => e.country === 'US' && e.importance === 3 && e.source === 'Investing.com'));
  assert(!api.calMatches({ country: 'CA', importance: 3, type: 'economic' }, 'high'));
  assert(!api.calMatches({ country: 'US', importance: 2, type: 'economic' }, 'high'));
  assert(!api.calMatches({ type: 'holiday' }, 'high'));
  assert(high.every(e => e.url.startsWith('https://www.investing.com/economic-calendar/')));
  assert(!high.some(e => e.date.startsWith('2027')));
});

test('observed indicators replace bundled releases without removing holidays or other dates', () => {
  const payrolls = api.CAL_EVENTS.filter(e => e.date === '2026-09-04');
  assert.equal(payrolls.length, 3);
  assert(payrolls.every(e => e.officialSource === 'BLS'));
  assert(payrolls.some(e => e.title === 'Unemployment Rate (Aug)'));
  assert.equal(api.CAL_EVENTS.filter(e => e.date === '2026-11-06').length, 1);
  const base = [
    { date: '2026-09-04', time: '08:30', short: 'Payrolls', source: 'BLS', note: 'Wages' },
    { date: '2026-09-04', time: null, short: 'Closed', source: 'NYSE' }
  ];
  const rows = [{ date: '2026-09-04', time: '08:30', replaces: 'Payrolls', note: 'Verified' }];
  const merged = api.calMergeInvesting(base, rows);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].source, 'NYSE');
  assert.equal(merged[1].officialSource, 'BLS');
  assert.match(merged[1].note, /Wages/);
  assert.equal(base.length, 2);
});

test('Investing overnight speech and winter Fed time survive timezone conversion', () => {
  const speech = api.CAL_INVESTING_EVENTS.find(e => e.short === 'President speech');
  assert.equal(speech.date, '2026-09-09');
  assert.equal(api.calDisplayDate(speech, 'Europe/Istanbul'), '2026-09-10');
  assert.equal(api.calTime(speech, 'Europe/Istanbul'), '04:15 TRT');
  const decision = api.CAL_INVESTING_EVENTS.find(e => e.date === '2026-12-09');
  assert.equal(api.calTime(decision, 'Europe/Istanbul'), '22:00 TRT');
});
