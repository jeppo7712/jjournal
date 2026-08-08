import DOMPurify from 'dompurify';

// Trade/day-note notes are authored with react-quill and stored as raw HTML.
// Sanitize before rendering via dangerouslySetInnerHTML to prevent stored XSS.
export function sanitizeNotesHtml(html) {
  if (!html) return '';
  return DOMPurify.sanitize(html, {
    // Matches the react-quill toolbar actually offered in TradeModal/DayNote:
    // bold, italic, header 1/2, ordered/bullet list, link, image.
    ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'b', 'i', 'u', 's', 'ol', 'ul', 'li', 'a', 'span', 'img', 'h1', 'h2', 'h3'],
    ALLOWED_ATTR: ['href', 'target', 'rel', 'class', 'src', 'alt'],
  });
}
