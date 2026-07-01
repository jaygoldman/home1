// Deterministic "what time of year/day is it" context — no network calls.

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const WEEKDAYS = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
];

// Northern-hemisphere seasons keyed by month index (0-11).
function seasonFor(month) {
  if (month <= 1 || month === 11) return 'winter';
  if (month <= 4) return 'spring';
  if (month <= 7) return 'summer';
  return 'autumn';
}

function partOfDay(hour) {
  if (hour < 5) return 'the small hours';
  if (hour < 8) return 'early morning';
  if (hour < 12) return 'morning';
  if (hour < 14) return 'midday';
  if (hour < 18) return 'afternoon';
  if (hour < 21) return 'evening';
  return 'night';
}

// A few fixed-date observances worth a nod ON THE DAY (month-day strings). This
// drives the "it's Christmas" line in the poem context — the single-day marquee.
const HOLIDAYS = {
  '01-01': "New Year's Day",
  '02-14': "Valentine's Day",
  '03-17': "St. Patrick's Day",
  '07-01': 'Canada Day',
  '07-04': 'Independence Day',
  '10-31': 'Halloween',
  '12-24': 'Christmas Eve',
  '12-25': 'Christmas',
  '12-31': "New Year's Eve",
};

// Holiday "seasons" — the stretch of the year when a tradition TAGGED with this
// holiday may surface. Distinct from the single-day nod above: a household's
// Christmas traditions should show across December, not only on the 25th, but
// must NOT show in July. `window` is [start, end] as MM-DD, inclusive and
// wrap-aware (a window that crosses year-end, like New Year's, is fine). Movable
// feasts (Easter, Hanukkah, Thanksgiving) use generous approximate windows —
// good enough to gate a household clock, not a liturgical calendar. This list
// also populates the Holiday drop-down in the web app (GET /api/admin/holidays).
export const HOLIDAY_DEFS = [
  { code: 'new_year',         name: "New Year's",            window: ['12-30', '01-02'] },
  { code: 'valentines',       name: "Valentine's Day",       window: ['02-07', '02-14'] },
  { code: 'st_patricks',      name: "St. Patrick's Day",     window: ['03-10', '03-17'] },
  { code: 'easter',           name: 'Easter',                window: ['03-20', '04-25'] },
  { code: 'mothers_day',      name: "Mother's Day",          window: ['05-06', '05-14'] }, // 2nd Sun of May
  { code: 'fathers_day',      name: "Father's Day",          window: ['06-13', '06-21'] }, // 3rd Sun of June
  { code: 'summer_solstice',  name: 'Summer Solstice',       window: ['06-19', '06-22'] },
  { code: 'canada_day',       name: 'Canada Day',            window: ['06-25', '07-01'] },
  { code: 'independence_day', name: 'Independence Day (US)', window: ['06-28', '07-04'] },
  { code: 'grandparents_day', name: "Grandparents' Day",     window: ['09-05', '09-13'] }, // 2nd Sun of Sept
  { code: 'halloween',        name: 'Halloween',             window: ['10-17', '10-31'] },
  { code: 'thanksgiving_ca',  name: 'Thanksgiving (Canada)', window: ['10-04', '10-14'] },
  { code: 'thanksgiving_us',  name: 'Thanksgiving (US)',     window: ['11-20', '11-28'] },
  { code: 'winter_solstice',  name: 'Winter Solstice',       window: ['12-20', '12-23'] },
  { code: 'hanukkah',         name: 'Hanukkah',              window: ['12-06', '12-26'] },
  { code: 'christmas',        name: 'Christmas',             window: ['12-01', '12-26'] },
];

const mdNum = (md) => Number(md.slice(0, 2)) * 100 + Number(md.slice(3, 5));

// Is MM-DD `md` inside [start, end] (inclusive)? Wrap-aware: when start > end the
// window straddles year-end (e.g. Dec 30 -> Jan 2).
function withinWindow(md, [start, end]) {
  const v = mdNum(md), a = mdNum(start), b = mdNum(end);
  return a <= b ? v >= a && v <= b : v >= a || v <= b;
}

// Should a tradition tagged with holiday `code` surface right now? Empty/unknown
// codes fail OPEN — untagged traditions always show, and a tag whose holiday we
// no longer define is shown rather than silently lost. A recognized tag only
// shows inside its window.
export function holidayActive(code, month, day) {
  if (!code) return true;
  const def = HOLIDAY_DEFS.find((h) => h.code === code);
  if (!def) return true;
  const md = `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return withinWindow(md, def.window);
}

// Parse the local wall-clock fields for a given IANA timezone.
function localParts(date, tz) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'long', hour12: false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(date).map((p) => [p.type, p.value])
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month), // 1-12
    day: Number(parts.day),
    hour: Number(parts.hour === '24' ? '0' : parts.hour),
    minute: Number(parts.minute),
    weekday: parts.weekday,
  };
}

// Upcoming birthdays (within `windowDays`) from the people list.
function upcomingBirthdays(people, month, day, windowDays = 7) {
  const out = [];
  const today = month * 100 + day;
  for (const p of people || []) {
    const bd = (p.birthday || '').trim();
    const m = bd.match(/(\d{1,2})-(\d{1,2})$/); // MM-DD or YYYY-MM-DD tail
    if (!m) continue;
    const bMonth = Number(m[1]);
    const bDay = Number(m[2]);
    if (!bMonth || !bDay) continue;
    const key = bMonth * 100 + bDay;
    // crude "within window" across month boundaries
    let diff = key - today;
    if (diff < 0) diff += 1200; // wrap a bit for year-end; good enough for a nudge
    const approxDays = Math.abs(bMonth - month) * 30 + (bDay - day);
    if (key === today) out.push(`${p.name}'s birthday is today`);
    else if (approxDays > 0 && approxDays <= windowDays) {
      out.push(`${p.name}'s birthday is coming up (${bMonth}/${bDay})`);
    }
  }
  return out;
}

export function temporalContext(tz = 'America/Toronto', people = [], now = new Date()) {
  const { year, month, day, hour, minute, weekday } = localParts(now, tz);
  const season = seasonFor(month - 1);
  const mdKey = `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const holiday = HOLIDAYS[mdKey];
  const isWeekend = weekday === 'Saturday' || weekday === 'Sunday';
  const dayPart = partOfDay(hour);

  const bits = [
    `${weekday}, ${MONTHS[month - 1]} ${day}, ${year}`,
    `${season}`,
    `${dayPart}`,
    isWeekend ? 'the weekend' : 'a weekday',
  ];
  if (holiday) bits.push(`it's ${holiday}`);

  // Summer = school's out hint for kid-relevant poems.
  if (season === 'summer' && month >= 7 && month <= 8) bits.push("school's out");

  const birthdays = upcomingBirthdays(people, month, day);

  return {
    line: bits.join('; '),
    season,
    dayPart,
    weekday,
    isWeekend,
    holiday: holiday || null,
    month, // 1-12, exposed so the engine can gate holiday-tagged traditions
    day,
    birthdays,
    time24: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
  };
}
