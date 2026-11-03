import { getJson } from "./http.js"

export async function currentTemperature(city) {
  const reading = await getJson(`https://weather.example.invalid/now?city=${encodeURIComponent(city)}`)
  return `${Math.round(reading.celsius)}°C`
}
