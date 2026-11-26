// Vorprüfung (Triage) für eingehendes Feedback im Headhunter-Stil:
// Sortiert leeren Text, Test-Eingaben ("asdf", "test", "!!!") und reines Rauschen aus,
// bevor ein Jira-Ticket entsteht. Der Admin kann in der Inbox jederzeit "Trotzdem übertragen" klicken.
'use strict';

const JUNK_EXACT = new Set([
  'test',
  'testing',
  'asdf',
  'qwertz',
  'qwerty',
  'hallo',
  'hello',
  'hi',
  'bla',
  'blabla',
  '123',
  '1234',
  '12345',
  'xxx',
  'ok',
  'nope',
  'none'
]);

function triageFeedback({ title = '', message = '' }) {
  const combined = `${String(title || '').trim()} ${String(message || '').trim()}`.trim();
  const letters = combined.replace(/[^a-zA-ZäöüÄÖÜß0-9]/g, '');
  if (letters.length < 6) {
    return {
      keep: false,
      stage: 'deterministic',
      reason: 'Zu kurz oder kein verwertbarer Text (< 6 alphanumerische Zeichen).'
    };
  }
  const low = combined.toLowerCase().replace(/[^a-zäöüß0-9\s]/g, '').trim();
  const words = low.split(/\s+/).filter(Boolean);
  if (JUNK_EXACT.has(low) || (words.length > 0 && words.every((w) => JUNK_EXACT.has(w)))) {
    return {
      keep: false,
      stage: 'deterministic',
      reason: `Offensichtliche Testeingabe („${low}“).`
    };
  }
  // Wiederholtes Einzelzeichen wie "aaaaaaaaaa" oder "!!!!!!!!!!"
  const uniqueChars = new Set(letters.toLowerCase().split(''));
  if (uniqueChars.size <= 2 && letters.length >= 6) {
    return {
      keep: false,
      stage: 'deterministic',
      reason: 'Wiederholte Zeichenfolge ohne erkennbare Rückmeldung.'
    };
  }
  return {
    keep: true,
    stage: 'deterministic',
    reason: 'Inhalt plausibel und für Jira-Export geeignet.'
  };
}

module.exports = { triageFeedback };
