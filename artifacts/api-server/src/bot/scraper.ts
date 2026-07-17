import axios from "axios";
import * as cheerio from "cheerio";

export interface ScrapedChapter {
  title: string;
  content: string;
  url: string;
  paragraphs: string[];
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

function extractParagraphs($: cheerio.CheerioAPI, contentEl: cheerio.Cheerio<cheerio.AnyNode>): string[] {
  const paragraphs: string[] = [];

  contentEl.find("p, h2, h3, h4, h5, h6").each((_, el) => {
    const tag = (el as cheerio.Element).tagName?.toLowerCase() ?? "";
    if (SKIP_TAGS.has(tag)) return;

    const text = cleanText($(el).text());
    if (text.length > 20) {
      paragraphs.push(text);
    }
  });

  // If no paragraphs found via <p> tags, fall back to full text split
  if (paragraphs.length === 0) {
    const fullText = cleanText(contentEl.text());
    const lines = fullText.split(/\n+/).filter((l) => l.trim().length > 20);
    paragraphs.push(...lines);
  }

  return paragraphs;
}

export async function scrapeChapter(url: string): Promise<ScrapedChapter> {
  const { data: html } = await axios.get(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; DiscordBot/1.0)",
      "Accept": "text/html,application/xhtml+xml",
    },
    timeout: 15000,
  });

  const $ = cheerio.load(html);

  // Remove noise
  $("script, style, nav, header, footer, aside, noscript, .sharedaddy, .jp-relatedposts, .comments-area, #comments").remove();

  const hostname = new URL(url).hostname.replace("www.", "");
  const siteSelectors = SELECTORS_BY_HOST[hostname];

  // Find title
  let title = "";
  const titleSelectors = siteSelectors?.title ?? GENERIC_TITLE_SELECTORS;
  for (const sel of titleSelectors) {
    const el = $(sel).first();
    if (el.length && el.text().trim()) {
      title = cleanText(el.text());
      break;
    }
  }
  if (!title) title = $("title").text().split("|")[0]?.trim() ?? "Chapter";

  // Find content
  let paragraphs: string[] = [];
  const contentSelectors = siteSelectors?.content ?? GENERIC_CONTENT_SELECTORS;

  for (const sel of contentSelectors) {
    const el = $(sel).first();
    if (el.length) {
      const found = extractParagraphs($, el);
      if (found.length >= 3) {
        paragraphs = found;
        break;
      }
    }
  }

  if (paragraphs.length === 0) {
    throw new Error(
      "Could not extract readable content from that page. Make sure it's a public chapter URL."
    );
  }

  return {
    title,
    content: paragraphs.join("\n\n"),
    url,
    paragraphs,
  };
}
