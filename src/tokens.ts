// The same split as search.tokens in sql/schema.sql.
export function tokens(q: string): string[] {
  return q.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean)
}

// The phrase's words in order, from the start of a word of text, ignoring accents and the spaces
// and punctuation between words: "almond milk" is in ALMONDMILK, "hellmanns" in HELLMANN'S,
// "jalapeno" in JALAPEÑO and "strawb" in STRAWBERRY.
export function carries(text: string, phrase: string): boolean {
  const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '')
  const target = tokens(fold(phrase)).join('')
  const words = tokens(fold(text))
  return target !== '' && words.some((_, i) => words.slice(i).join('').startsWith(target))
}
