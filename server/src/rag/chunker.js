const DEFAULT_MAX_CHARS = 800;
const DEFAULT_OVERLAP_CHARS = 100;

// Splits a markdown document on H2 ("## ") boundaries. Each section keeps
// the document's H1 title and its own heading as a prefix, so a chunk read
// in isolation (as retrieval will present it) still carries its topic —
// e.g. "Shipping Policy > International Shipping" rather than a bare
// paragraph with no context.
function splitIntoSections(markdown) {
  const lines = markdown.split('\n');
  let title = '';
  const sections = [];
  let current = null;
  const preamble = [];

  for (const line of lines) {
    const h1Match = line.match(/^#\s+(.*)/);
    const h2Match = line.match(/^##\s+(.*)/);

    if (h1Match && !title) {
      title = h1Match[1].trim();
      continue;
    }

    if (h2Match) {
      if (current) sections.push(current);
      current = { heading: h2Match[1].trim(), lines: [] };
      continue;
    }

    if (current) {
      current.lines.push(line);
    } else {
      // Content between the H1 and the first H2 — kept as its own
      // "Overview" section rather than silently dropped.
      preamble.push(line);
    }
  }
  if (current) sections.push(current);

  if (preamble.join('\n').trim()) {
    sections.unshift({ heading: 'Overview', lines: preamble });
  }

  return sections.map((section) => ({
    title,
    heading: section.heading,
    body: section.lines.join('\n').trim(),
  }));
}

// A long section is further split by paragraph, accumulating up to
// maxChars per chunk with a small trailing overlap carried into the next
// chunk so a fact sitting right at a split boundary isn't stranded without
// context on either side.
function splitLongBody(body, maxChars, overlapChars) {
  const paragraphs = body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const parts = [];
  let current = '';

  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length > maxChars && current) {
      parts.push(current);
      const overlap = current.slice(Math.max(0, current.length - overlapChars));
      current = `${overlap}\n\n${paragraph}`;
    } else {
      current = candidate;
    }
  }
  if (current) parts.push(current);

  return parts;
}

// Returns [{ heading, text }]. `text` is what gets embedded and shown to
// the model; `heading` (e.g. "Shipping Policy > International Shipping")
// is kept separately for metadata/attribution.
export function chunkMarkdown(markdown, { maxChars = DEFAULT_MAX_CHARS, overlapChars = DEFAULT_OVERLAP_CHARS } = {}) {
  const sections = splitIntoSections(markdown);
  const chunks = [];

  for (const section of sections) {
    if (!section.body) continue;
    const heading = section.title ? `${section.title} > ${section.heading}` : section.heading;

    if (section.body.length <= maxChars) {
      chunks.push({ heading, text: `${heading}\n\n${section.body}` });
    } else {
      const parts = splitLongBody(section.body, maxChars, overlapChars);
      for (const part of parts) {
        chunks.push({ heading, text: `${heading}\n\n${part}` });
      }
    }
  }

  return chunks;
}
