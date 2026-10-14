import fs from 'node:fs/promises';
import axios from 'axios';

// Vul hier je API key in van bijv. ZenRows, ScrapingBee of WebScrapingAPI
const API_KEY = process.env.SCRAPER_API_KEY;

// Lijst van URL's die je wilt scrapen
const urls = [
    'https://trends.knack.be/nieuws/macro-economie-beleid/de-cartoon-van-de-week-van-karl/'
];

async function fetchAndSavePages() {
    for (let i = 0; i < urls.length; i++) {
        const targetUrl = encodeURIComponent(urls[i]);
        const fileName = `page${i + 1}.html`;

        // js_render=true zorgt ervoor dat de JavaScript-challenge/WAF wordt uitgevoerd
        const apiUrl = `https://api.zenrows.com/v1/?key=${API_KEY}&url=${targetUrl}&js_render=true`;

        try {
            console.log(`Ophalen van [${i + 1}/${urls.length}]: ${urls[i]}...`);
            
            const response = await axios.get(apiUrl, { responseType: 'text' });

            // Sla de opgehaalde pure HTML op
            await fs.writeFile(fileName, response.data, 'utf-8');
            console.log(`Succesvol opgeslagen als: ${fileName}`);

        } catch (error) {
            console.error(`Fout bij ophalen van ${urls[i]}:`, error.message);
        }
    }
}

fetchAndSavePages();
