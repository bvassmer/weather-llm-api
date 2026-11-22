import type { OutlookSummaryFacts } from "./types.js";

const MAX_EVIDENCE_SENTENCES = 8;
const MAX_SENTENCE_LENGTH = 400;
const MAX_EVIDENCE_CHARACTERS = 2400;
const MAX_PASSAGE_CHARACTERS = 6000;
const COMPLETE_SENTENCE = /[.!?]["')\]]*$/;
const TIME_ABBREVIATION = /\b(?:a\.m\.|p\.m\.)$/i;
const TIME_ZONE = /^(?:[ECMP][DS]T|UTC)\b/i;
const QUALIFYING_SENTENCE = /^(?:(?:however|still|that said),\s+)?(?:(?:forecast )?confidence (?:is|remains) (?:low|limited|modest)|uncertainty (?:is|remains) (?:high|considerable|substantial)|(?:this|that|the) (?:threat|risk|scenario|potential) (?:depends on|is (?:conditional|contingent) on))\b/i;
const sentenceSegmenter = new Intl.Segmenter("en-US", {
  granularity: "sentence",
});
const forecastTimeFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  weekday: "short",
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  timeZoneName: "short",
});

type EvidenceSentence = {
  id: number;
  heading: string;
  text: string;
  passageIndex: number;
  sentenceIndex: number;
  followingQualifier?: string;
};

const normalizedText = (value: unknown): string =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";

const readFacts = (values: unknown): string[] =>
  Array.isArray(values)
    ? [...new Set(values.slice(0, 8).map(normalizedText).filter(
        (text) => text && text.length <= 240,
      ))]
    : [];

const finishSentence = (text: string): string =>
  COMPLETE_SENTENCE.test(text) ? text : `${text}.`;

const readForecastTime = (value: unknown): Date | undefined => {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  ) {
    return undefined;
  }

  const date = new Date(value);
  const calendarDay = value.slice(0, 10);
  const day = new Date(`${calendarDay}T00:00:00Z`);
  if (
    !Number.isFinite(date.getTime()) ||
    day.toJSON()?.slice(0, 10) !== calendarDay
  ) {
    return undefined;
  }

  return date;
};

const formatValidity = (validity: OutlookSummaryFacts["validity"]): string => {
  const start = readForecastTime(validity?.start);
  const end = readForecastTime(validity?.end);
  if (start && end) {
    return start < end
      ? `${forecastTimeFormatter.format(start)} to ${forecastTimeFormatter.format(end)}`
      : "Official validity unavailable";
  }
  if (start) return `From ${forecastTimeFormatter.format(start)}`;
  if (end) return `Until ${forecastTimeFormatter.format(end)}`;
  return "Official validity unavailable";
};

const formatCoverage = (coverage: OutlookSummaryFacts["coverage"]): string => {
  const location =
    normalizedText(coverage?.location).slice(0, 120) || "Report location";
  let scope: string;
  switch (coverage?.status) {
    case "inside":
      scope = "inside the mapped area";
      break;
    case "nearby": {
      const distance = coverage.distanceMiles;
      scope =
        typeof distance === "number" && Number.isFinite(distance) && distance > 0
          ? `near the mapped area, ${Number(distance.toFixed(1))} miles from the boundary`
          : "near the mapped area";
      break;
    }
    case "outside":
      scope = "outside the mapped area";
      break;
    default:
      scope = "local coverage unverified";
  }
  return `${location} (${scope})`;
};

const splitSentences = (text: string): string[] => {
  const sentences: string[] = [];
  for (const { segment } of sentenceSegmenter.segment(text)) {
    const sentence = segment.trim();
    const previous = sentences.at(-1);
    if (previous && TIME_ABBREVIATION.test(previous) && TIME_ZONE.test(sentence)) {
      sentences[sentences.length - 1] = `${previous} ${sentence}`;
    } else if (sentence) {
      sentences.push(sentence);
    }
  }
  return sentences;
};

export const getEvidenceSentences = (
  facts: OutlookSummaryFacts,
): EvidenceSentence[] => {
  // Ingestion has already scoped these passages to the report location and day.
  if (facts.coverage?.status === "outside" || !Array.isArray(facts.evidence)) {
    return [];
  }

  const evidence: EvidenceSentence[] = [];
  const seen = new Set<string>();
  let usedCharacters = 0;
  for (const [passageIndex, passage] of facts.evidence.slice(0, 8).entries()) {
    const heading = normalizedText(passage?.heading).slice(0, 120);
    const text = normalizedText(passage?.text);
    const sentences = splitSentences(text.slice(0, MAX_PASSAGE_CHARACTERS));
    if (text.length > MAX_PASSAGE_CHARACTERS) sentences.pop();
    for (const [sentenceIndex, sentence] of sentences.entries()) {
      const key = sentence.toLowerCase();
      if (
        sentence.length > MAX_SENTENCE_LENGTH ||
        !COMPLETE_SENTENCE.test(sentence) ||
        seen.has(key)
      ) {
        continue;
      }
      const length = heading.length + sentence.length;
      if (
        usedCharacters + length > MAX_EVIDENCE_CHARACTERS ||
        evidence.length >= MAX_EVIDENCE_SENTENCES
      ) {
        return evidence;
      }
      const following = sentences[sentenceIndex + 1];
      const followingQualifier =
        following && following.length <= MAX_SENTENCE_LENGTH &&
        COMPLETE_SENTENCE.test(following) && QUALIFYING_SENTENCE.test(following)
          ? following
          : undefined;
      evidence.push({
        id: evidence.length + 1,
        heading,
        text: sentence,
        passageIndex,
        sentenceIndex,
        followingQualifier,
      });
      seen.add(key);
      usedCharacters += length;
    }
  }
  return evidence;
};

export const buildEvidencePrompt = (
  evidence: readonly EvidenceSentence[],
): string =>
  [
    "Choose the official weather discussion sentence that best describes the expected local impact.",
    "Return only its number. If two consecutive sentences in the same passage are needed to preserve the impact and its uncertainty, return both numbers separated by a comma.",
    "Return NONE if these sentences give no local impact. Do not create any new text.",
    "Official source sentences:",
    ...evidence.map(({ id, heading, text }) =>
      `${id}. ${heading ? `[${heading}] ` : ""}${text}`,
    ),
  ].join("\n");

const contiguous = (first: EvidenceSentence, second: EvidenceSentence): boolean =>
  first.passageIndex === second.passageIndex &&
  first.sentenceIndex + 1 === second.sentenceIndex;

export const parseSelectedEvidence = (
  result: string,
  evidence: readonly EvidenceSentence[],
): EvidenceSentence[] | undefined => {
  const response = result.trim();
  if (response === "NONE") return [];
  const match = /^([1-9]\d*)(?:\s*,\s*([1-9]\d*))?$/.exec(response);
  if (!match) return undefined;
  const first = evidence[Number(match[1]) - 1];
  if (!first) return undefined;
  if (!match[2]) return [first];
  const second = evidence[Number(match[2]) - 1];
  return second && contiguous(first, second) ? [first, second] : undefined;
};

export const fallbackEvidence = (
  evidence: readonly EvidenceSentence[],
): EvidenceSentence[] => {
  const [first, second] = evidence;
  if (!first) return [];
  return second && contiguous(first, second) ? [first, second] : [first];
};

export const renderCompactBriefing = (
  facts: OutlookSummaryFacts,
  evidence: readonly EvidenceSentence[],
): string => {
  const risks = readFacts(facts.risks);
  const values = readFacts(facts.values);
  const lines = [
    `Where: ${finishSentence(formatCoverage(facts.coverage))}`,
    `When: ${finishSentence(formatValidity(facts.validity))}`,
    `Risk: ${finishSentence(risks.join(" | ") || "Unavailable")}`,
  ];
  if (values.length) lines.push(`Details: ${finishSentence(values.join(" | "))}`);
  if (evidence.length) {
    const heading = evidence[0].heading;
    const attribution = heading
      ? `Official discussion (${heading})`
      : "Official discussion";
    const excerpts = evidence.map(({ text }) => text);
    const followingQualifier = evidence.at(-1)?.followingQualifier;
    if (followingQualifier) excerpts.push(followingQualifier);
    lines.push(`${attribution}: ${excerpts.join(" ")}`);
  }
  return lines.join("\n");
};
