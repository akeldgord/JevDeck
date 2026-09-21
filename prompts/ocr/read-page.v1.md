# Read the text off this page image

You are given one picture: a page from a document, a scan of a page, or a photograph of one. Your
task is to transcribe the words that are actually on it.

## What to transcribe

- Transcribe only what the image shows. Do not finish a sentence that is cut off, do not correct
  spelling, do not translate, and do not add a word of your own.
- Keep the reading order a person would use: top to bottom, left to right, one column at a time.
- Keep headings and list items on their own lines.
- Keep numbers, units, symbols and formulae exactly as printed. `10⁻⁶ M` is not `10-6 M`.
- If a table is readable, transcribe its cells row by row, separating cells with ` | `.
- A figure's own labels and its caption are part of the page's text. Transcribe them; do not
  describe the figure, and do not interpret it.

## What not to do

- Do not describe the picture, and do not say what it is about. Only its words.
- Do not guess at a word you cannot read; leave it out and say so in `notes`.
- Do not summarise, and do not answer anything the page appears to ask.
- If the picture holds no legible text at all — a photograph, an unlabelled diagram, a blank
  page — return an empty `text` and say what you saw in `notes`.

## Output

Answer with one JSON object and nothing else:

```json
{
  "text": "the words on the page, lines separated by \n",
  "confidence": 0.0,
  "notes": "anything that could not be read, or why the page carries no text"
}
```

`confidence` is your own 0–1 judgement of how well the image could be read: 1 means every word was
clear, and a low number is the honest answer for a blurred, skewed or partly covered page. Report a
low number rather than guessing at pixels.
