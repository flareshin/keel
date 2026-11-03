export async function getJson(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`GET ${url} failed with ${response.status}`)
  return response.json()
}
