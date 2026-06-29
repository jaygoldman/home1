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

// A few fixed-date observances worth a nod (month-day strings).
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
    birthdays,
    time24: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
  };
}
