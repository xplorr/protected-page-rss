import fs from "fs/promises";

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

const browserlessUrl =
  `https://production-sfo.browserless.io/unblock?token=${encodeURIComponent(BROWSERLESS_TOKEN)}&proxy=residential`;

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

function buildIndexHtml({ title, pageUrl, images, buildDate, feedFileName }) {
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
  <p>Generated on ${buildDate}</p>
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
      Page: <a href="./${entry.indexFileName}">${entry.indexFileName}</a>
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
  const response = await fetch(browserlessUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      url: targetUrl,
      content: true,
      cookies: false,
      screenshot: false,
      browserWSEndpoint: false
    })
  });

  if (!response.ok) {
    throw new Error(`Browserless request failed with status ${response.status}`);
  }

  const data = await response.json();

  if (!data.content || typeof data.content !== "string") {
    throw new Error("Browserless returned no HTML content");
  }

  return data.content;
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

    console.log(`Processing URL #${number}...`);

    const html = await fetchSolvedHtml(targetUrl);
    const title = extractTitle(html);
    const description = extractDescription(html);
    const images = extractImages(html, targetUrl);

    if (images.length === 0) {
      console.warn(`No images found for URL #${number}`);
    }

    const feedXml = buildFeedXml({
      title,
      description,
      pageUrl: targetUrl,
      images,
      buildDate
    });

    const indexHtml = buildIndexHtml({
      title,
      pageUrl: targetUrl,
      images,
      buildDate,
      feedFileName
    });

    await fs.writeFile(`public/${feedFileName}`, feedXml, "utf8");
    await fs.writeFile(`public/${indexFileName}`, indexHtml, "utf8");

    landingEntries.push({
      title,
      pageUrl: targetUrl,
      feedFileName,
      indexFileName
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
