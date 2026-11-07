import { getJson } from "./http.js"

export async function feedTitles() {
  const items = await getJson("https://feed.example.invalid/items")
  return items.map((item) => item.title)
}
