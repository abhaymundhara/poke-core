const STOPWORDS = new Set([
  'a','an','and','are','as','at','be','by','for','from','has','have','how','i','in','is','it','of','on','or','that','the','their','this','to','was','were','what','when','where','which','who','why','with','you','your','me','my','we','they','them','our','us','can','could','should','would','will','just','about','into','over','under','after','before','near','next','last','today','tomorrow'
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]+/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

export function expandTokens(tokens: string[]): string[] {
  const expanded = new Set(tokens);
  for (const token of tokens) {
    if (token.endsWith('s')) expanded.add(token.slice(0, -1));
    if (token.endsWith('ing')) expanded.add(token.slice(0, -3));
    if (token.includes('_')) token.split('_').filter(Boolean).forEach((part) => expanded.add(part));
    if (token.includes('-')) token.split('-').filter(Boolean).forEach((part) => expanded.add(part));
  }
  return [...expanded];
}

export function phraseHits(query: string, text: string): string[] {
  const phrases = query.match(/"([^"]+)"|'([^']+)'/g)?.map((p) => p.slice(1, -1)) ?? [];
  return phrases.filter((phrase) => text.toLowerCase().includes(phrase.toLowerCase()));
}
