You are writing the narration for a short explainer video about the attached PDF document.

Write a spoken summary of the document, split into scenes. Each scene shows one page of the PDF while the narration is read aloud.

Rules:
- Only state claims that the document itself supports. Do not add outside facts, opinions or guesses. If the document is unclear, say less rather than invent.
- Write plain spoken sentences, as a person would say them. No markdown, no bullet points, no headings, no lists, no emoji, no stage directions, no URLs or citations read out.
- Write the narration in this language: {{LANG}}. Set "language" to "{{LANG}}".
- Total length: about {{WORD_BUDGET}} words of narration across all scenes (the video should last about {{LENGTH_SECONDS}} seconds).
- Use at most {{MAX_SCENES}} scenes. Fewer is fine when the document is short.
- "id" counts up from 1 in scene order.
- "page" is the 1-based position of the page in the file (the first page of the file is 1), not the page number printed on the page. The file has {{PAGE_COUNT}} pages, so "page" must be between 1 and {{PAGE_COUNT}}. Follow the document's order of ideas; pages may be skipped.
- "focus" is optional. Add it only when the narration discusses one specific region of the page (a figure, a table, one paragraph). It is a box given as fractions from 0 to 1 of the page, with the origin at the top left: x and y are the left and top edges, w and h the width and height. Keep x + w <= 1 and y + h <= 1. Leave it out when the whole page is the subject.
- "title" is a short title for the whole video.
