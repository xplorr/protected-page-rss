import fs from "fs/promises";
import { chromium } from "playwright-core";

const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN;
const TARGET_URLS_JSON = process.env.TARGET_URLS_JSON;

if (!BROWSERLESS_TOKEN) {
  console.error("Missing BROWSERLESS_TOKEN secret");
  process.exit(1);
}

if (!TARGET_URLS_JSON) {
  console.error("Missing TARGET_URLS_JSON secret");
  process.exit(1);
}

let targetUrls;

try {
  targetUrls = JSON.parse(TARGET_URLS_JSON);
} catch {
  console.error("TARGET_URLS_JSON is not valid JSON");
  process.exit(1);
}

if (!Array.isArray(targetUrls) || targetUrls.length === 0) {
  console.error("TARGET_URLS_JSON must be a non-empty JSON array of URLs");
  process.exit(1);
}

function escapeXml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function stripTags(html = "") {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function absoluteUrl(url, base) {
  try {
    return new URL(url, base).toString();
  } catch {
    return url;
  }
}

function extractMetaContent(html, attrName, attrValue) {
  const regex = new RegExp(
    `<meta[^>]+${attrName}=["']${attrValue}["'][^>]+content=["']([^"']+)["']`,
    "i"
  );
  const match = html.match(regex);
  return match?.[1]?.trim() || "";
}

function extractTitle(html) {
  const ogTitle = extractMetaContent(html, "property", "og:title");
  if (ogTitle) return ogTitle;

  const titleMatch = html.match(/<title>(.*?)<\/title>/is);
  if (titleMatch?.[1]) return stripTags(titleMatch[1]);

  const h1Match = html.match(/<h1[^>]*>(.*?)<\/h1>/is);
  if (h1Match?.[1]) return stripTags(h1Match[1]);

  return "Generated feed";
}

function extractDescription(html) {
  const ogDescription = extractMetaContent(html, "property", "og:description");
  if (ogDescription) return ogDescription;

  const metaDescription = extractMetaContent(html, "name", "description");
  if (metaDescription) return metaDescription;

  return "Daily generated RSS feed.";
}

function extractImages(html, baseUrl) {
  const matches = [...html.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)];

  const urls = matches
    .map((match) => absoluteUrl(match[1], baseUrl))
    .filter((url) => /^https?:\/\//i.test(url))
    .filter((url) => !url.startsWith("data:"));

  return [...new Set(urls)];
}

function guessMimeType(url) {
  const lower = url.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  return "image/jpeg";
}

function looksBlocked(html) {
  const text = html.toLowerCase();
  return (
    text.includes("human verification") ||
    text.includes("let's confirm you are human") ||
    text.includes("captcha") ||
    text.includes("request blocked") ||
    text.includes("the request could not be satisfied")
  );
}

function buildFeedXml({ title, description, pageUrl, images, buildDate }) {
  const items = images
    .map((imgUrl, index) => {
      const itemTitle = `${title} - image ${index + 1}`;
      const mimeType = guessMimeType(imgUrl);

      return `
    <item>
      <title>${escapeXml(itemTitle)}</title>
      <link>${escapeXml(pageUrl)}</link>
      <guid>${escapeXml(imgUrl)}</guid>
      <pubDate>${escapeXml(buildDate)}</pubDate>
      <description><![CDATA[<p><img src="${imgUrl}" alt="${escapeXml(itemTitle)}" /></p>]]></description>
      <enclosure url="${escapeXml(imgUrl)}" type="${escapeXml(mimeType)}" />
    </item>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${escapeXml(title)}</title>
    <link>${escapeXml(pageUrl)}</link>
    <description>${escapeXml(description)}</description>
    <language>en</language>
    <lastBuildDate>${escapeXml(buildDate)}</lastBuildDate>${items}
  </channel>
</rss>
`;
}

function buildIndexHtml({
  title,
  pageUrl,
  images,
  buildDate,
  feedFileName,
  debugFileName,
  note
}) {
  const imageLinks = images
    .map((img) => `<li><a href="${img}">${img}</a></li>`)
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${title}</title>
</head>
<body>
  <h1>${title}</h1>
  <p>Original page: <a href="${pageUrl}">${pageUrl}</a></p>
  <p>RSS feed: <a href="./${feedFileName}">${feedFileName}</a></p>
  <p>Debug HTML: <a href="./${debugFileName}">${debugFileName}</a></p>
  <p>Generated on ${buildDate}</p>
  ${note ? `<p><strong>${note}</strong></p>` : ""}
  <h2>Images found</h2>
  <ul>
    ${imageLinks}
  </ul>
</body>
</html>`;
}

function buildLandingPage(entries, buildDate) {
  const links = entries
    .map(
      (entry) => `
    <li>
      <strong>${entry.title}</strong><br />
      Source: <a href="${entry.pageUrl}">${entry.pageUrl}</a><br />
      Feed: <a href="./${entry.feedFileName}">${entry.feedFileName}</a><br />
      Page: <a href="./${entry.indexFileName}">${entry.indexFileName}</a><br />
      Debug HTML: <a href="./${entry.debugFileName}">${entry.debugFileName}</a>
    </li>`
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Generated feeds</title>
</head>
<body>
  <h1>Generated feeds</h1>
  <p>Updated on ${buildDate}</p>
  <ul>
    ${links}
  </ul>
</body>
</html>`;
}

async function fetchSolvedHtml(targetUrl) {
  const wsEndpoint =
    `wss://production-sfo.browserless.io/stealth?token=${encodeURIComponent(BROWSERLESS_TOKEN)}&proxy=residential&solveCaptchas=true&timeout=300000`;

  const browser = await chromium.connectOverCDP(wsEndpoint);

  try {
    const context = browser.contexts()[0];
    const page = context.pages()[0];
    const cdp = await page.context().newCDPSession(page);

    const captchaSolved = new Promise((resolve) => {
      cdp.on("Browserless.captchaAutoSolved", resolve);
    });

    await page.goto(targetUrl, { waitUntil: "networkidle" });

    await Promise.race([
      captchaSolved,
      new Promise((resolve) => setTimeout(resolve, 30000))
    ]);

    await page.waitForLoadState("networkidle");

    const html = await page.content();
    const finalUrl = page.url();
    const title = await page.title();

    return {
      html,
      finalUrl,
      title
    };
  } finally {
    await browser.close();
  }
}

async function main() {
  const buildDate = new Date().toUTCString();

  await fs.mkdir("public", { recursive: true });

  const landingEntries = [];

  for (let i = 0; i < targetUrls.length; i += 1) {
    const targetUrl = targetUrls[i];
    const number = i + 1;
    const feedFileName = `feed${number}.xml`;
    const indexFileName = `index${number}.html`;
    const debugFileName = `debug${number}.html`;

    console.log(`Processing URL #${number}...`);

    const { html, finalUrl, title: browserTitle } = await fetchSolvedHtml(targetUrl);

    await fs.writeFile(`public/${debugFileName}`, html, "utf8");

    const title = extractTitle(html) || browserTitle || `Feed ${number}`;
    const description = extractDescription(html);
    const images = extractImages(html, finalUrl || targetUrl);

    let note = `Final URL: ${finalUrl}.`;

    if (looksBlocked(html)) {
      note += " Returned HTML still looks blocked.";
    } else {
      note += " Returned HTML does not look obviously blocked.";
    }

    if (images.length === 0) {
      note += " No images were found.";
    } else {
      note += ` Found ${images.length} image(s).`;
    }

    const feedXml = buildFeedXml({
      title,
      description,
      pageUrl: finalUrl || targetUrl,
      images,
      buildDate
    });

    const indexHtml = buildIndexHtml({
      title,
      pageUrl: finalUrl || targetUrl,
      images,
      buildDate,
      feedFileName,
      debugFileName,
      note
    });

    await fs.writeFile(`public/${feedFileName}`, feedXml, "utf8");
    await fs.writeFile(`public/${indexFileName}`, indexHtml, "utf8");

    landingEntries.push({
      title,
      pageUrl: finalUrl || targetUrl,
      feedFileName,
      indexFileName,
      debugFileName
    });
  }

  const landingPage = buildLandingPage(landingEntries, buildDate);
  await fs.writeFile("public/index.html", landingPage, "utf8");

  console.log(`Generated ${landingEntries.length} feed(s).`);
}

main().catch((error) => {
  console.error("Build failed:", error.message);
  process.exit(1);
});
