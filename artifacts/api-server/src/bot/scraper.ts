import axios from "axios";
import * as cheerio from "cheerio";

export interface ChapterSection {
  title: string;
  startParagraph: number; // index into paragraphs[]
}

export interface ScrapedChapter {
  title: string;
  content: string;
  url: string;
  paragraphs: string[];
  /** Detected sections/chapters within the page (headings, scene breaks, hr). */
  sections: ChapterSection[];
}

const SELECTORS_BY_HOST: Record<string, { content: string[]; title: string[] }> = {
  "witchculttranslations.com": {
    title: [".entry-title", "h1.title", "h1"],
    content: [".entry-content", ".post-content", "article"],
  },
  "witchcult.com": {
    title: [".entry-title", "h1"],
    content: [".entry-content", ".post-content"],
  },
  "archiveofourown.org": {
    title: ["h2.title.heading", "h3.title", "h2.title"],
    content: [".userstuff[role='article']", "#chapters .userstuff", ".userstuff"],
  },
};

const GENERIC_CONTENT_SELECTORS = [
  "article .entry-content",
  ".entry-content",
  ".post-content",
  ".chapter-content",
  ".content-text",
  "article",
  ".post-body",
  "main p",
];

const GENERIC_TITLE_SELECTORS = [
  ".entry-title",
  ".post-title",
  ".chapter-title",
  "h1.title",
  "h1",
];

const SKIP_TAGS = new Set(["script", "style", "nav", "header", "footer", "aside", "noscript"]);

function cleanText(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Check if a paragraph is a scene-divider (---, ***, ~~~, etc.) */
function isSceneDivider(text: string): boolean {
  return /^[-*~=✦◆·•]{3,}$/.test(text.replace(/\s/g, ""));
}

// AO3 heading text that is structural metadata, not story content
const AO3_META_HEADINGS = /^(notes?|summary|end notes?|beginning notes?|author.?s note|works inspired|chapter \d+)/i;

interface ExtractResult {
  paragraphs: string[];
  sections: ChapterSection[];
}

function extractParagraphs(
  $: cheerio.CheerioAPI,
  contentEl: cheerio.Cheerio<cheerio.AnyNode>,
  opts: { hrAsSceneBreak: boolean } = { hrAsSceneBreak: true },
): ExtractResult {
  const paragraphs: string[] = [];
  const sections: ChapterSection[] = [];
  let partCounter = 0;

  contentEl.find("p, h1, h2, h3, h4, h5, h6, hr").each((_, el) => {
    const tag = (el as cheerio.Element).tagName?.toLowerCase() ?? "";
    if (SKIP_TAGS.has(tag)) return;

    // Horizontal rule — only treat as scene break on non-AO3 sites
    if (tag === "hr") {
      if (opts.hrAsSceneBreak && paragraphs.length > 0) {
        partCounter++;
        sections.push({ title: `Part ${partCounter}`, startParagraph: paragraphs.length });
      }
      return;
    }

    const text = cleanText($(el).text());
    if (!text) return;

    // Heading = named chapter/section boundary
    if (/^h[1-6]$/.test(tag) && text.length < 200) {
      // Skip AO3 structural metadata headings
      if (AO3_META_HEADINGS.test(text)) return;
      // Mark boundary at the current paragraph position
      sections.push({ title: text, startParagraph: paragraphs.length });
      // Also include heading as a spoken paragraph so TTS announces it
      if (text.length > 3) paragraphs.push(text);
      return;
    }

    if (text.length < 2) return;

    // Scene divider pattern (text-based, works everywhere)
    if (isSceneDivider(text)) {
      if (paragraphs.length > 0) {
        partCounter++;
        sections.push({ title: `Part ${partCounter}`, startParagraph: paragraphs.length });
      }
      return;
    }

    paragraphs.push(text);
  });

  // If no paragraphs found via <p> tags, fall back to full text split
  if (paragraphs.length === 0) {
    const fullText = cleanText(contentEl.text());
    const lines = fullText.split(/\n+/).filter((l) => l.trim().length > 20);
    paragraphs.push(...lines);
  }

  return { paragraphs, sections };
}

function extraConfig(hostname: string): { headers?: Record<string, string>; params?: Record<string, string> } {
  if (hostname === "archiveofourown.org") {
    return {
      headers: { Cookie: "view_adult=true" },
    };
  }
  return {};
}

function buildAo3Title($: cheerio.CheerioAPI): string {
  const workTitle    = cleanText($("h2.title.heading").first().text());
  const chapterTitle = cleanText($(".chapter .title").first().text().replace(/^Chapter\s+\d+[:.]?\s*/i, ""));
  if (workTitle && chapterTitle) return `${workTitle} — ${chapterTitle}`;
  if (workTitle) return workTitle;
  return "Chapter";
}

export async function scrapeChapter(url: string): Promise<ScrapedChapter> {
  const hostname = new URL(url).hostname.replace("www.", "");
  const extra    = extraConfig(hostname);

  const { data: html } = await axios.get(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml",
      ...extra.headers,
    },
    timeout: 15000,
  });

  const $ = cheerio.load(html);

  $(
    "script, style, nav, header, footer, aside, noscript, " +
    ".sharedaddy, .jp-relatedposts, .comments-area, #comments, " +
    "#header, #footer, #main > .wrapper > .message, " +
    ".kudos, .bookmarks, .hits, #kudos, .comment_count"
  ).remove();

  // AO3: strip all author notes, chapter summaries, prefaces, and
  // afterwords before extracting — these are metadata, not story text.
  if (hostname === "archiveofourown.org") {
    $(
      ".notes, .end-notes, .beginning-notes, " +
      ".preface .notes, .preface .summary, " +
      ".chapter .notes, .chapter .summary, " +
      ".afterword, .preface.group, " +
      "#chapters .chapter + .preface, " +         // next-chapter preface
      ".chapter > .notes.module, " +
      "blockquote.userstuff ~ .notes, " +
      ".chapter > header .notes"
    ).remove();

    // Also remove the "AOYeet" / converter credit line that appears as a <p>
    $("p:contains('AOYeet'), p:contains('converted for free')").remove();
  }

  const siteSelectors = SELECTORS_BY_HOST[hostname];

  let title = "";
  if (hostname === "archiveofourown.org") {
    title = buildAo3Title($);
  } else {
    const titleSelectors = siteSelectors?.title ?? GENERIC_TITLE_SELECTORS;
    for (const sel of titleSelectors) {
      const el = $(sel).first();
      if (el.length && el.text().trim()) {
        title = cleanText(el.text());
        break;
      }
    }
  }
  if (!title) title = $("title").text().split("|")[0]?.trim() ?? "Chapter";

  let paragraphs: string[] = [];
  let sections: ChapterSection[] = [];
  const contentSelectors = siteSelectors?.content ?? GENERIC_CONTENT_SELECTORS;

  const isAo3 = hostname === "archiveofourown.org";
  for (const sel of contentSelectors) {
    const el = $(sel).first();
    if (el.length) {
      const found = extractParagraphs($, el, { hrAsSceneBreak: !isAo3 });
      if (found.paragraphs.length >= 3) {
        paragraphs = found.paragraphs;
        sections   = found.sections;
        break;
      }
    }
  }

  if (paragraphs.length === 0) {
    throw new Error(
      "Could not extract readable content from that page. " +
      "Make sure it's a public chapter URL (AO3, WCT, or similar)."
    );
  }

  return {
    title,
    content: paragraphs.join("\n\n"),
    url,
    paragraphs,
    sections,
  };
}
