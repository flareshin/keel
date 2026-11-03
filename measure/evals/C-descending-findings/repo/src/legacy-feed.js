export async function feedTitles() {
  const response = await fetch("https://feed.example.invalid/items")
  const items = await response.json()
  return items.map((item) => item.title)
}
