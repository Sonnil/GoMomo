// ============================================================
// Storefront Retrieval Engine — BM25-style keyword search
// ============================================================
// Searches the approved corpus (markdown docs) using TF-IDF/BM25-inspired
// scoring. This is a lightweight in-memory retrieval system — no external
// dependencies, no embeddings API calls.
//
// The corpus is loaded once at import time from the corpus/ directory.
// To add new approved docs, drop a .md file in corpus/ and restart.
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Types ───────────────────────────────────────────────────

export interface CorpusDocument {
  /** Filename (e.g. "privacy.md") */
  source: string;
  /** Full raw text */
  text: string;
  /** Pre-split paragraphs (passages) */
  passages: string[];
}

export interface RetrievalResult {
  passage: string;
  source: string;
  score: number;
}

export interface RetrievalOutput {
  results: RetrievalResult[];
  query: string;
}

// ── Corpus Loading ──────────────────────────────────────────

const CORPUS_DIR = path.join(__dirname, 'corpus');

let _corpus: CorpusDocument[] | null = null;

/**
 * Load all .md files from the corpus directory.
 * Cached after first call. Call resetCorpusCache() to reload.
 */
export function loadCorpus(): CorpusDocument[] {
  if (_corpus) return _corpus;

  if (!fs.existsSync(CORPUS_DIR)) {
    console.warn(`[storefront-retrieval] Corpus directory not found: ${CORPUS_DIR}`);
    _corpus = [];
    return _corpus;
  }

  const files = fs.readdirSync(CORPUS_DIR).filter((f) => f.endsWith('.md'));
  _corpus = files.map((file) => {
    const text = fs.readFileSync(path.join(CORPUS_DIR, file), 'utf-8');
    const passages = splitIntoPassages(text);
    return { source: file, text, passages };
  });

  console.log(`[storefront-retrieval] Loaded ${_corpus.length} corpus documents (${_corpus.reduce((n, d) => n + d.passages.length, 0)} passages)`);
  return _corpus;
}

/** Clear the in-memory corpus cache (useful for testing). */
export function resetCorpusCache(): void {
  _corpus = null;
}

// ── Passage Splitting ───────────────────────────────────────

/**
 * Split a markdown document into meaningful passages.
 * Strategy: split on headings (## or ###) and double-newlines,
 * keeping passages between 50-500 chars for good retrieval granularity.
 */
function splitIntoPassages(text: string): string[] {
  // Split on markdown headings or double newlines
  const raw = text.split(/\n(?=#{1,3}\s)|\n\n+/);
  const passages: string[] = [];

  for (const chunk of raw) {
    const trimmed = chunk.trim();
    if (trimmed.length < 20) continue; // skip tiny fragments

    if (trimmed.length > 600) {
      // Split long passages on sentence boundaries
      const sentences = trimmed.match(/[^.!?]+[.!?]+/g) ?? [trimmed];
      let buffer = '';
      for (const sentence of sentences) {
        if (buffer.length + sentence.length > 500) {
          if (buffer.trim().length >= 20) passages.push(buffer.trim());
          buffer = sentence;
        } else {
          buffer += sentence;
        }
      }
      if (buffer.trim().length >= 20) passages.push(buffer.trim());
    } else {
      passages.push(trimmed);
    }
  }

  return passages;
}

// ── BM25-inspired Scoring ───────────────────────────────────

const BM25_K1 = 1.5;
const BM25_B = 0.75;

/** Tokenize text into lowercase terms, strip punctuation. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

/** Simple stopword set — not exhaustive, just enough to help relevance. */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
  'before', 'after', 'above', 'below', 'between', 'out', 'off', 'over',
  'under', 'again', 'further', 'then', 'once', 'here', 'there', 'when',
  'where', 'why', 'how', 'all', 'each', 'every', 'both', 'few', 'more',
  'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own',
  'same', 'so', 'than', 'too', 'very', 'and', 'but', 'or', 'if', 'it',
  'its', 'my', 'your', 'this', 'that', 'these', 'those', 'what', 'which',
  'who', 'whom', 'he', 'she', 'they', 'we', 'you', 'me', 'him', 'her',
  'us', 'them', 'i', 'am',
]);

function removeStopwords(tokens: string[]): string[] {
  return tokens.filter((t) => !STOPWORDS.has(t));
}

/**
 * Compute IDF for each term across all passages.
 */
function computeIDF(allPassages: string[][]): Map<string, number> {
  const N = allPassages.length;
  const docFreq = new Map<string, number>();

  for (const tokens of allPassages) {
    const unique = new Set(tokens);
    for (const term of unique) {
      docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
    }
  }

  const idf = new Map<string, number>();
  for (const [term, df] of docFreq) {
    idf.set(term, Math.log((N - df + 0.5) / (df + 0.5) + 1));
  }
  return idf;
}

// ── Main Retrieval Function ─────────────────────────────────

/**
 * Retrieve the top-k most relevant passages from the approved corpus.
 *
 * @param query - User's question
 * @param topK - Number of passages to return (default 3)
 * @returns Ranked passages with scores and source file names
 */
export function retrieveStorefrontContext(query: string, topK = 3): RetrievalOutput {
  const corpus = loadCorpus();
  if (corpus.length === 0) {
    return { results: [], query };
  }

  // Flatten all passages with source tracking
  const allPassages: Array<{ passage: string; source: string; tokens: string[] }> = [];
  for (const doc of corpus) {
    for (const passage of doc.passages) {
      allPassages.push({
        passage,
        source: doc.source,
        tokens: removeStopwords(tokenize(passage)),
      });
    }
  }

  if (allPassages.length === 0) {
    return { results: [], query };
  }

  // Compute IDF across all passages
  const idf = computeIDF(allPassages.map((p) => p.tokens));

  // Average passage length
  const avgLen = allPassages.reduce((sum, p) => sum + p.tokens.length, 0) / allPassages.length;

  // Score query against each passage (BM25)
  const queryTokens = removeStopwords(tokenize(query));

  const scored: RetrievalResult[] = allPassages.map(({ passage, source, tokens }) => {
    let score = 0;
    const termFreq = new Map<string, number>();
    for (const t of tokens) {
      termFreq.set(t, (termFreq.get(t) ?? 0) + 1);
    }

    for (const qt of queryTokens) {
      const tf = termFreq.get(qt) ?? 0;
      if (tf === 0) continue;
      const termIdf = idf.get(qt) ?? 0;
      const numerator = tf * (BM25_K1 + 1);
      const denominator = tf + BM25_K1 * (1 - BM25_B + BM25_B * (tokens.length / avgLen));
      score += termIdf * (numerator / denominator);
    }

    return { passage, source, score };
  });

  // Sort by score descending and take top-k
  scored.sort((a, b) => b.score - a.score);
  const results = scored.slice(0, topK).filter((r) => r.score > 0);

  return { results, query };
}

/**
 * Returns true if retrieval produced meaningful results
 * (at least one result with score > threshold).
 */
export function isRetrievalConfident(output: RetrievalOutput, threshold = 1.0): boolean {
  return output.results.length > 0 && output.results[0].score > threshold;
}
