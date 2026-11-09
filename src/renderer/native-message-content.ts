import { MAX_MESSAGE_MARKUP } from './message-format.js';
import { safeRecordedReplyImage } from '../shared/external-link.js';

type Capture = { text: string; truncated: boolean };
export type NativeMessageActions = { key: string; copy(value: string): Promise<boolean>; openOriginal?(): void;
  loadImage?(url: string): Promise<string | null> };
type Criterion = { label: string; max: number; values: number[] };
type Scorecard = { names: string[]; labels: string[]; criteria: Criterion[] };
type ScoreState = { names: string[]; scores: number[][] };

const scoreStates = new Map<string, ScoreState>();
const label = (node?: Element | null) => node?.textContent?.trim().slice(0, 240) ?? '';
const number = (value: string | null | undefined) => value && /^\d{1,4}$/.test(value) ? Number(value) : null;
const SLIDER = '[role="slider"], input[type="range"]';

/** The canonical message's observed public UI, before the transcript sanitizer runs. */
export function nativeMessageMarkup(capture: Capture | null | undefined, messageId: string | undefined): string | null {
  if (!messageId || !capture?.text || capture.truncated || capture.text.length > MAX_MESSAGE_MARKUP ||
      !/data-(?:dil-response|onecode-rich-message)/.test(capture.text)) return null;
  const template = document.createElement('template');
  template.innerHTML = capture.text;
  const portable = [...template.content.querySelectorAll('[data-onecode-rich-message]')];
  if (portable.length === 1 && portable[0]!.parentNode === template.content &&
      portable[0]!.getAttribute('data-onecode-rich-message') === messageId) return capture.text;
  const responses = [...template.content.querySelectorAll('[data-dil-response]')];
  return responses.length && responses.every(response =>
    response.closest('[data-dil-source-message-id]')?.getAttribute('data-dil-source-message-id') === messageId)
    ? capture.text : null;
}

function readScorecard(card: Element): Scorecard | null {
  const headings = [...(card.firstElementChild?.children ?? [])];
  if (headings.length !== 2 || card.querySelectorAll('input[type="text"]').length !== 2) return null;
  const names: string[] = [], labels: string[] = [];
  for (const heading of headings) {
    const input = heading.querySelector('input[type="text"]');
    const field = [...heading.querySelectorAll('label')].find(node =>
      (node.id && node.id === input?.getAttribute('aria-labelledby')) ||
      (input?.id && node.htmlFor === input.id));
    if (!input || !field || !label(field)) return null;
    names.push((input.getAttribute('value') ?? '').slice(0, 120));
    labels.push(label(field));
  }
  const criteria: Criterion[] = [];
  const allSliders = card.querySelectorAll(SLIDER);
  if (!allSliders.length || allSliders.length > 24) return null;
  for (const row of [...card.children].slice(1)) {
    if (!row.querySelector(SLIDER)) continue;
    const [title, fields] = row.children;
    const name = label(title?.firstElementChild ?? undefined);
    const slots = [...(fields?.children ?? [])];
    if (!name || slots.length !== 2 || row.children.length !== 2) return null;
    const ranges = slots.map(slot => [...slot.querySelectorAll(SLIDER)]);
    if (ranges.some(range => range.length !== 1)) return null;
    const sliders = ranges.map(range => range[0]!);
    const bound = (slider: Element, key: 'min' | 'max' | 'now') =>
      slider.getAttribute(`aria-value${key}`) ?? slider.getAttribute(key === 'now' ? 'value' : key);
    const max = number(bound(sliders[0]!, 'max'));
    const values = sliders.map(slider => number(bound(slider, 'now')));
    if (!max || sliders.some(slider => bound(slider, 'min') !== '0' ||
        number(bound(slider, 'max')) !== max) || values.some(value => value === null || value > max)) return null;
    criteria.push({ label: name, max, values: values as number[] });
  }
  const total = criteria.reduce((sum, row) => sum + row.max, 0);
  const matchesTotals = headings.every((heading, side) => {
    const score = criteria.reduce((sum, row) => sum + row.values[side]!, 0);
    return [...heading.querySelectorAll('output, p, span')].some(node => label(node).replace(/\s+/g, '') === `${score}/${total}`) ||
      (heading.textContent ?? '').replace(/\s+/g, '').endsWith(`${labels[side]!.replace(/\s+/g, '')}${score}/${total}`);
  });
  return criteria.length * 2 === allSliders.length && matchesTotals ? { names, labels, criteria } : null;
}

function panel(): HTMLElement {
  const node = document.createElement('section');
  node.className = 'native-content-card';
  return node;
}

function action(title: string, click: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = title;
  button.addEventListener('click', click);
  return button;
}

function copyButton(title: string, value: () => string, copy: NativeMessageActions['copy']): HTMLButtonElement {
  const button = action(title, () => {
    void copy(value()).then(ok => { button.textContent = ok ? 'Copied' : 'Could not copy'; },
      () => { button.textContent = 'Could not copy'; });
  });
  return button;
}

function scorecardView(card: Scorecard, options: NativeMessageActions, index: number): HTMLElement {
  const { criteria, labels } = card;
  const max = criteria.reduce((sum, row) => sum + row.max, 0);
  const defaults = (): ScoreState => ({ names: [...card.names], scores: criteria.map(row => [...row.values]) });
  const key = JSON.stringify([options.key, index, card]);
  let state = scoreStates.get(key) ?? defaults();
  scoreStates.delete(key);
  scoreStates.set(key, state);
  if (scoreStates.size > 100) scoreStates.delete(scoreStates.keys().next().value!);
  const box = panel();
  box.setAttribute('aria-label', 'Interactive scorecard');
  const header = document.createElement('div');
  header.className = 'native-content-columns';
  const totals: HTMLOutputElement[] = [];
  const names = labels.map((title, side) => {
    const slot = document.createElement('div'), field = document.createElement('label');
    const name = document.createElement('input'), total = document.createElement('output');
    name.type = 'text';
    name.maxLength = 120;
    name.value = state.names[side]!;
    name.addEventListener('input', () => { state.names[side] = name.value; refresh(); });
    total.setAttribute('aria-label', `${title} total`);
    field.append(title, name);
    slot.append(field, total);
    header.append(slot);
    totals.push(total);
    return name;
  });
  box.append(header);
  const score = (side: number) => state.scores.reduce((sum, row) => sum + row[side]!, 0);
  const nameOf = (side: number) => state.names[side]?.trim() || labels[side]!;
  const controls = criteria.map((criterion, row) => {
    const group = document.createElement('fieldset'), legend = document.createElement('legend');
    const grid = document.createElement('div');
    grid.className = 'native-content-columns';
    legend.textContent = criterion.label;
    group.append(legend, grid);
    box.append(group);
    return labels.map((_, side) => {
      const field = document.createElement('label'), summary = document.createElement('span');
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = '0';
      slider.max = String(criterion.max);
      slider.addEventListener('input', () => { state.scores[row]![side] = slider.valueAsNumber; refresh(); });
      field.append(summary, slider);
      grid.append(field);
      return { summary, slider };
    });
  });
  function refresh() {
    totals.forEach((total, side) => { total.value = `${score(side)} / ${max}`; });
    controls.forEach((row, i) => row.forEach(({ slider, summary }, side) => {
      const value = state.scores[i]![side]!;
      slider.value = String(value);
      slider.setAttribute('aria-label', `${nameOf(side)} — ${criteria[i]!.label}`);
      summary.textContent = `${nameOf(side)} · ${value} / ${criteria[i]!.max}`;
    }));
  }
  const actions = document.createElement('div');
  actions.className = 'native-content-actions';
  actions.append(copyButton('Copy comparison results', () => [
    `${nameOf(0)} — ${score(0)} / ${max}`, `${nameOf(1)} — ${score(1)} / ${max}`,
    ...criteria.map((row, i) => `${row.label}: ${state.scores[i]![0]} / ${row.max} · ${state.scores[i]![1]} / ${row.max}`)
  ].join('\n'), options.copy), action('Reset scores', () => {
    state = defaults();
    scoreStates.set(key, state);
    names.forEach((name, side) => { name.value = state.names[side]!; });
    refresh();
  }));
  box.append(actions);
  refresh();
  return box;
}

function weightsView(card: Element): HTMLElement | null {
  const [header, chart, legend] = card.children;
  const title = label(header?.firstElementChild ?? undefined);
  const segments = [...(chart?.children ?? [])] as HTMLElement[];
  const rows = [...(legend?.children ?? [])];
  if (card.children.length !== 3 || !title || segments.length < 2 || segments.length > 12 || segments.length !== rows.length) return null;
  const weights = segments.map((segment, i) => {
    const row = rows[i]!;
    const name = label(row.children[1]);
    const value = number(label(row.children[2]));
    const color = segment.style?.backgroundColor;
    return row.children.length === 3 && name && value && segment.style.flexGrow === String(value) &&
      /^rgb\(\d{1,3},\s*\d{1,3},\s*\d{1,3}\)$/.test(color) ? { name, value, color } : null;
  });
  if (!weights.every(weight => weight !== null)) return null;
  const box = panel(), heading = document.createElement('strong'), bar = document.createElement('div'), list = document.createElement('ul');
  heading.textContent = `${title} · ${weights.reduce((sum, row) => sum + row.value, 0)} points total`;
  bar.className = 'native-content-bar';
  bar.setAttribute('aria-hidden', 'true');
  list.className = 'native-content-columns native-content-legend';
  for (const weight of weights) {
    const segment = document.createElement('span'), entry = document.createElement('li'), swatch = document.createElement('span');
    segment.style.flexGrow = String(weight.value);
    segment.style.backgroundColor = swatch.style.backgroundColor = weight.color;
    bar.append(segment);
    entry.append(swatch, `${weight.name} ${weight.value}`);
    list.append(entry);
  }
  box.append(heading, bar, list);
  return box;
}

function replyImage(node: Element | null, caption: string[] = []) {
  if (!node || node.closest('[hidden], [aria-hidden="true"]')) return null;
  const url = node.getAttribute('src') ?? '';
  return safeRecordedReplyImage(url) ? { url, alt: node.getAttribute('alt')?.slice(0, 300) ?? '', caption } : null;
}

function imageGrid(items: NonNullable<ReturnType<typeof replyImage>>[], options: NativeMessageActions) {
  const view = document.createElement('div'), gallery = document.createElement('div');
  gallery.className = items.length === 1 ? 'native-reply-images' : 'native-reply-images has-columns';
  view.append(gallery);
  const fallback = options.openOriginal ? action('Open original in provider', options.openOriginal) : null;
  if (fallback) { fallback.className = 'native-content-original'; fallback.hidden = true; view.append(fallback); }
  const load = items.map(item => {
    const figure = document.createElement('figure'), image = document.createElement('img');
    const status = document.createElement('span');
    status.textContent = 'Loading image…';
    image.alt = item.alt;
    image.hidden = true;
    figure.append(image, status);
    if (item.caption.length) {
      const caption = document.createElement('figcaption'), heading = document.createElement('strong');
      heading.textContent = item.caption[0]!;
      caption.append(heading);
      for (const description of item.caption.slice(1)) {
        const paragraph = document.createElement('p');
        paragraph.textContent = description;
        caption.append(paragraph);
      }
      figure.append(caption);
    }
    gallery.append(figure);
    const unavailable = () => {
      image.hidden = true;
      status.hidden = false;
      status.textContent = item.alt || 'Image unavailable';
      if (fallback) fallback.hidden = false;
    };
    return () => void options.loadImage!(item.url).then(data => {
      if (!data || !/^data:image\/(?:jpeg|png|webp);base64,[a-z0-9+/=]+$/i.test(data)) return unavailable();
      image.addEventListener('error', unavailable, { once: true });
      image.src = data;
      image.hidden = false;
      status.hidden = true;
    }).catch(unavailable);
  });
  return { view, load: () => load.forEach(start => start()) };
}

/** Extract typed values from inert markup. Mount only app-owned DOM after the caller sanitizes. */
export function stageNativeMessageContent(fragment: DocumentFragment, options: NativeMessageActions, nativeCapture = false): () => void {
  const cards: Array<{ slot: Element; view: HTMLElement; load?: () => void }> = [];
  const stage = (source: Element, view: HTMLElement, load?: () => void) => {
    const slot = document.createElement('div');
    source.replaceWith(slot);
    cards.push({ slot, view, load });
  };
  const responses = nativeCapture ? [...fragment.querySelectorAll('[data-dil-response], [data-onecode-rich-message]')] : [];
  const visible = (node: Element) => !node.closest('[hidden], [aria-hidden="true"], script, style, pre, code, svg, template');
  for (const response of responses) {
    if (options.loadImage) {
      for (const grid of response.querySelectorAll('[data-d-component="grid"]')) {
        if (grid.children.length < 2 || grid.children.length > 8 || !visible(grid) || !fragment.contains(grid)) continue;
        const items = [...grid.children].map(column => {
          if (!column.matches('[data-d-component="grid-item"]')) return null;
          const sources = column.querySelectorAll('[data-d-component="image"] > img');
          if (sources.length !== 1) return null;
          const caption = [...column.children].slice(1).filter(node => node.tagName === 'P' && visible(node))
            .map(node => node.textContent?.trim().slice(0, 3000) ?? '').filter(Boolean);
          return replyImage(sources[0]!, caption);
        });
        if (items.every(item => item !== null)) {
          const { view, load } = imageGrid(items, options);
          stage(grid, view, load);
        }
      }
      for (const frame of [...response.querySelectorAll('[data-d-component="image"]')].slice(0, 8)) {
        const item = visible(frame) ? replyImage(frame.querySelector(':scope > img')) : null;
        if (item) {
          const { view, load } = imageGrid([item], options);
          stage(frame, view, load);
        }
      }
    }
    for (const widget of response.querySelectorAll('[data-client-defined-widget="code_block"]')) {
      if (!visible(widget)) continue;
      const sources = widget.querySelectorAll('[data-code-block-source] > code');
      const source = sources.length === 1 ? sources[0] : undefined;
      if (!source?.textContent || source.closest('[hidden], [aria-hidden="true"]')) continue;
      const pre = document.createElement('pre'), code = document.createElement('code');
      const nativeLabel = label(widget.querySelector('[data-markdown-copy="exclude"]')).toLowerCase();
      const language = source.getAttribute('class')?.match(/(?:^|\s)language-([a-z0-9_+#.-]{1,24})(?=\s|$)/i)?.[1] ??
        (nativeLabel === 'plain text' ? 'text' : nativeLabel);
      if (/^[a-z0-9_+#.-]{1,24}$/i.test(language)) code.className = `language-${language.toLowerCase()}`;
      code.textContent = source.textContent;
      pre.append(code);
      widget.replaceWith(pre);
    }
    for (const card of [...response.children]) {
      if (!visible(card)) continue;
      const view = weightsView(card);
      if (view) stage(card, view);
    }
  }
  // A portable pair of labelled fields and ranges can come from any provider. Limit
  // the ancestor search to the card surrounding the name fields.
  for (const input of fragment.querySelectorAll('input[type="text"]')) {
    if (!visible(input) || !fragment.contains(input)) continue;
    for (let parent = input.parentElement, depth = 0; parent && depth < 5; parent = parent.parentElement, depth++) {
      const card = readScorecard(parent);
      if (!card) continue;
      stage(parent, scorecardView(card, options, cards.length));
      break;
    }
  }
  for (const button of fragment.querySelectorAll(nativeCapture ? 'button[data-copy-text], [data-dil-response] button' : 'button[data-copy-text]')) {
    if (!visible(button) || button.closest('[data-code-block-controls], [data-markdown-copy="exclude"]')) continue;
    const title = label(button) || 'Copy';
    const payload = button.getAttribute('data-copy-text');
    const row = button.parentElement, card = row?.parentElement;
    const promptCard = /^copy prompt$/i.test(title) && row?.matches('[data-d-component="row"]') &&
      row.children.length === 2 && row.lastElementChild === button &&
      card?.matches('[data-d-component="box"]') && card.children.length === 2 &&
      card.lastElementChild?.tagName === 'P';
    let view: HTMLElement;
    if (payload?.trim() && payload.length <= 64_000) {
      view = copyButton(title, () => payload, options.copy);
    } else if (button.closest('[data-dil-response]') && label(button) &&
        (button.matches('[data-d-component="button"]') && /^copy\s/i.test(title) || /^copy prompt$/i.test(title))) {
      const openLabel = /^copy prompt$/i.test(title) ? 'Open original prompt in provider' : 'Open original in provider';
      view = options.openOriginal ? action(openLabel, options.openOriginal) : document.createElement('span');
      if (!options.openOriginal) view.textContent = 'Available in the original provider chat';
      view.title = title;
      view.className = 'native-content-original';
    } else continue;
    if (promptCard && row && card) {
      const box = panel(), heading = document.createElement('strong'), detail = document.createElement('p');
      heading.textContent = label(row.firstElementChild);
      detail.textContent = label(card.lastElementChild);
      box.append(heading, detail, view);
      stage(card, box);
    } else {
      stage(button, view);
    }
  }
  for (const response of responses) {
    // A copy button is not interactive content: a plain copiable prompt
    // (copy prompt / copy text) must not gain an "open in provider" row.
    // Only a real widget control (iframe, form field, slider, or a
    // non-copy button) counts as interactive content that OneCode cannot
    // import locally; exportable native artifacts take the artifact path.
    const interactive = [...response.querySelectorAll('input, button, select, textarea, [role="slider"], iframe')]
      .some(control => {
        if (!visible(control) || control.closest('[data-code-block-controls], [data-markdown-copy="exclude"]')) return false;
        if (control.tagName === 'BUTTON' &&
            (control.hasAttribute('data-copy-text') || /^copy\b/i.test(label(control)))) return false;
        return true;
      });
    if (!options.openOriginal || !interactive) continue;
    const slot = document.createElement('div');
    response.append(slot);
    const view = action('Open interactive content in provider', options.openOriginal);
    view.className = 'native-content-original';
    cards.push({ slot, view });
  }
  return () => { for (const { slot, view, load } of cards) { slot.replaceWith(view); load?.(); } };
}
