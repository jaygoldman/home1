// Open-Meteo weather: keyless geocoding + current conditions, cached.
import { getSettings, updateSettings } from '../db.js';

let cache = { at: 0, data: null };
const TTL_MS = 25 * 60 * 1000; // refresh ~every 25 min

// WMO weather codes -> short human phrase.
const WMO = {
  0: 'clear sky', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast',
  45: 'fog', 48: 'rime fog', 51: 'light drizzle', 53: 'drizzle',
  55: 'heavy drizzle', 56: 'freezing drizzle', 57: 'freezing drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain', 66: 'freezing rain',
  67: 'freezing rain', 71: 'light snow', 73: 'snow', 75: 'heavy snow',
  77: 'snow grains', 80: 'rain showers', 81: 'rain showers',
  82: 'violent rain showers', 85: 'snow showers', 86: 'heavy snow showers',
  95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'severe thunderstorm',
};

async function fetchJson(url, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// Resolve a free-text place name to lat/lon via Open-Meteo geocoding.
export async function geocode(place) {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place)}&count=1&language=en&format=json`;
  const data = await fetchJson(url);
  const hit = data?.results?.[0];
  if (!hit) return null;
  return {
    lat: hit.latitude,
    lon: hit.longitude,
    name: [hit.name, hit.admin1, hit.country_code].filter(Boolean).join(', '),
  };
}

// Ensure settings has lat/lon; geocode from the city context_item if missing.
export async function ensureLocation() {
  const s = getSettings();
  if (s.weather_lat != null && s.weather_lon != null) return s;
  // try to find a city context item
  const { db } = await import('../db.js');
  const city = db
    .prepare(`SELECT value FROM context_items WHERE category='city' AND active=1 ORDER BY id LIMIT 1`)
    .get();
  const place = city?.value || s.weather_place;
  if (!place) return s;
  const geo = await geocode(place);
  if (!geo) return s;
  return updateSettings({
    weather_lat: geo.lat,
    weather_lon: geo.lon,
    weather_place: geo.name,
  });
}

export async function refreshWeather({ force = false } = {}) {
  const s = getSettings();
  if (!s.weather_enabled) {
    cache = { at: 0, data: null };
    return null;
  }
  if (!force && cache.data && Date.now() - cache.at < TTL_MS) return cache.data;

  const located = await ensureLocation();
  if (located.weather_lat == null || located.weather_lon == null) return null;

  const tempUnit = located.weather_units === 'F' ? 'fahrenheit' : 'celsius';
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${located.weather_lat}` +
    `&longitude=${located.weather_lon}` +
    `&current=temperature_2m,weather_code,wind_speed_10m,is_day` +
    `&daily=temperature_2m_max,temperature_2m_min` +
    `&timezone=auto&temperature_unit=${tempUnit}&forecast_days=1`;

  const data = await fetchJson(url);
  const cur = data?.current || {};
  const daily = data?.daily || {};
  const unit = located.weather_units === 'F' ? '°F' : '°C';
  const result = {
    place: located.weather_place || '',
    tempNow: Math.round(cur.temperature_2m),
    condition: WMO[cur.weather_code] || 'changeable skies',
    isDay: cur.is_day === 1,
    high: daily.temperature_2m_max ? Math.round(daily.temperature_2m_max[0]) : null,
    low: daily.temperature_2m_min ? Math.round(daily.temperature_2m_min[0]) : null,
    unit,
    fetchedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  };
  cache = { at: Date.now(), data: result };
  return result;
}

export function getCachedWeather() {
  return cache.data;
}

// One-line summary for the poem prompt, or null.
export function weatherLine() {
  const w = cache.data;
  if (!w) return null;
  const hl = w.high != null && w.low != null ? `, high ${w.high}${w.unit} / low ${w.low}${w.unit}` : '';
  return `${w.condition}, ${w.tempNow}${w.unit}${hl}${w.place ? ` in ${w.place}` : ''}`;
}
