import fs from 'node:fs/promises';
import axios from 'axios';

const API_KEY = process.env.SCRAPER_API_KEY;

if (!API_KEY) {
    console.error("FOUT: SCRAPER_API_KEY omgevingsvariabele ontbreekt!");
    process.exit(1);
}

const urls = [
    'https://trends.knack.be/nieuws/macro-economie-beleid/de-cartoon-van-de-week-van-karl'
];

async function fetchAndSavePages() {
    for (let i = 0; i < urls.length; i++) {
        const targetUrl = encodeURIComponent(urls[i]);
        const fileName = `page${i + 1}.html`;

        const apiUrl = `https://api.zenrows.com/v1/?apikey=${API_KEY}&url=${targetUrl}&js_render=true&premium_proxy=true`;

        try {
            console.log(`Ophalen [${i + 1}/${urls.length}]: ${urls[i]}... (dit kan enkele minuten duren)`);
            
            // Timeout ingesteld op 300 seconden (5 minuten)
            const response = await axios.get(apiUrl, { 
                responseType: 'text',
                timeout: 300000 
            });

            await fs.writeFile(fileName, response.data, 'utf-8');
            console.log(`Succesvol opgeslagen als: ${fileName}`);

        } catch (error) {
            if (error.code === 'ECONNABORTED') {
                console.error(`Timeout! Het verzoek duurde langer dan 5 minuten voor: ${urls[i]}`);
            } else if (error.response) {
                console.error(`Fout (${error.response.status}):`, error.response.data);
            } else {
                console.error(`Fout bij ophalen van ${urls[i]}:`, error.message);
            }
        }
    }
}

fetchAndSavePages();    
