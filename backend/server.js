require('dotenv').config();

const express = require('express');
const multer = require('multer');
const fs = require('fs').promises;
const path = require('path');
const OpenAI = require("openai");
const sanitizeHtml = require('sanitize-html');
const pdfParse = require('pdf-parse');
const HTMLtoDOCX = require('html-to-docx');
const cors = require('cors');
const stream = require('stream');
const util = require('util');
const pipeline = util.promisify(stream.pipeline);

console.log('Moduli importati correttamente');

const app = express();

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, path.join(__dirname, '..', 'uploads', 'pdf'))
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + '-' + file.originalname)
  }
});

const upload = multer({ storage: storage });

app.post('/api/upload', upload.single('file'), async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  try {
    const result = await processFile(req.file, res);
    res.write(`data: ${JSON.stringify(result)}\n\n`);
  } catch (error) {
    console.error('Errore durante l\'elaborazione del file:', error);
    res.write(`data: error: ${error.message}\n\n`);
  } finally {
    res.end();
  }
});

console.log('Express e Multer configurati');

const openai = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
  defaultHeaders: {
    "HTTP-Referer": process.env.YOUR_SITE_URL || "http://localhost:3000",
    "X-Title": process.env.YOUR_SITE_NAME || "Sin-Text",
  },
  timeout: 600000 // 10 minuti
});

console.log('Client OpenAI inizializzato');

app.use(express.json());
app.use(cors({
  origin: 'http://localhost:8080',
  credentials: true
}));
console.log('Middleware JSON configurato');

// Definisci i tre prompt come costanti
const PROMPT_PARTE_1 = `
PARTE 1 - Informazioni generali e obiettivi:
Analizza il documento fornito e sintetizza le seguenti informazioni in formato HTML:
<h2>Informazioni Generali</h2>
<p><strong>Commessa:</strong> [Titolo completo del progetto] ([Acronimo se presente])</p>
<p><strong>ID Commessa:</strong> [Numero progressivo, partendo da 1]</p>
<p><strong>Committente:</strong> [Nome completo del committente]</p>
<p><strong>Importo:</strong> [Importo in euro, senza decimali]</p>
<p><strong>Durata:</strong> [Durata in mesi]</p>
<h2>Obiettivo</h2>
<p>[Descrizione dettagliata dell'obiettivo principale del progetto]</p>
Assicurati di:

Mantenere tutti i dettagli forniti nel documento originale
Tradurre tutto in italiano
Usare un formato chiaro e dettagliato
`;

const PROMPT_PARTE_2 = `
PARTE 2 - Attività e prodotti:
Analizza il documento fornito e crea le seguenti tabelle in formato HTML:
<h2>Attività Richieste</h2>
<table style="width:100%; border-collapse: collapse; margin-bottom: 20px;">
<thead>
  <tr style="background-color: #f2f2f2;">
    <th style="border: 1px solid #ddd; padding: 8px; text-align: left;">Linea</th>
    <th style="border: 1px solid #ddd; padding: 8px; text-align: left;">ID Attività</th>
    <th style="border: 1px solid #ddd; padding: 8px; text-align: left;">Descrizione Attività</th>
  </tr>
</thead>
<tbody>
  [Inserisci righe della tabella qui]
</tbody>
</table>

<h2>Prodotti Richiesti</h2>
<table style="width:100%; border-collapse: collapse; margin-bottom: 20px;">
<thead>
  <tr style="background-color: #f2f2f2;">
    <th style="border: 1px solid #ddd; padding: 8px; text-align: left;">ID</th>
    <th style="border: 1px solid #ddd; padding: 8px; text-align: left;">Descrizione Prodotto</th>
    <th style="border: 1px solid #ddd; padding: 8px; text-align: left;">Qtà</th>
  </tr>
</thead>
<tbody>
  [Inserisci righe della tabella qui]
</tbody>
</table>
Istruzioni per la tabella delle Attività:

La "Linea" rappresenta il Filone di Attività (livello di raggruppamento più alto)
Assegna un ID progressivo a ciascuna attività (es. 1.1, 1.2, 2.1, 2.2)
Fornisci una descrizione dettagliata di ogni attività

Istruzioni per la tabella dei Prodotti:

Usa l'ID dell'attività correlata se specificato, altrimenti usa un numero progressivo
Fornisci una descrizione dettagliata di ogni prodotto
Indica la quantità (usa 1 se non specificata)
Includi TUTTI i prodotti elencati
Non raggruppare i prodotti/work packages (WP)
Tradurre tutto in italiano
`;

const PROMPT_PARTE_3 = `
PARTE 3 - Gruppo di lavoro e risorse:
Analizza il documento fornito e crea la seguente tabella in formato HTML, non troncare dati dalla tabella:
<h2>Gruppo di Lavoro</h2>
<table style="width:100%; border-collapse: collapse; margin-bottom: 20px;">
<thead>
  <tr style="background-color: #f2f2f2;">
    <th style="border: 1px solid #ddd; padding: 8px; text-align: left;">ID</th>
    <th style="border: 1px solid #ddd; padding: 8px; text-align: left;">Profilo</th>
    <th style="border: 1px solid #ddd; padding: 8px; text-align: left;">Esp. Minima</th>
    <th style="border: 1px solid #ddd; padding: 8px; text-align: left;">Competenze</th>
    <th style="border: 1px solid #ddd; padding: 8px; text-align: left;">Qtà</th>
    <th style="border: 1px solid #ddd; padding: 8px; text-align: left;">gg. Tot.</th>
  </tr>
</thead>
<tbody>
  [Inserisci righe della tabella qui]
  <tr>
    <td colspan="4" style="border: 1px solid #ddd; padding: 8px; text-align: right;"><strong>Totale:</strong></td>
    <td style="border: 1px solid #ddd; padding: 8px; text-align: left;">[Totale Qtà]</td>
    <td style="border: 1px solid #ddd; padding: 8px; text-align: left;">[Totale gg.]</td>
  </tr>
</tbody>
</table>
Istruzioni per la tabella del Gruppo di Lavoro:

Assegna un ID progressivo a ciascun profilo
Descrivi dettagliatamente il ruolo/profilo richiesto
Indica gli anni di esperienza minima (0 se non specificata)
Elenca tutte le competenze richieste in dettaglio
Indica la quantità richiesta (0 se non specificata)
Indica il totale di giorni lavorativi (0 se non specificato)
Aggiungi una riga "Totale:" alla fine della tabella con i totali delle colonne Qtà e gg. Tot.
Se possibile, calcola e aggiungi il valore €/gg dividendo l'Importo totale per il totale dei giorni lavorativi

<p>Valore €/gg: [Calcolo del valore €/gg se possibile]</p>
Assicurati di:

Non troncare i dati che potresti inserire nella tabella
Mantenere tutti i dettagli forniti nel documento originale
Tradurre tutto in italiano
Usare un formato chiaro e dettagliato
`;

async function elaboraDocumentoCompleto(pdfText, res) {
  console.log('Inizio elaborazione del documento');
  sendMessage(res, 'Inizio elaborazione del documento');
  sendMessage(res, 'progress:10');

  try {
    const promptCompleto = `
${PROMPT_PARTE_1}

${PROMPT_PARTE_2}

${PROMPT_PARTE_3}

Contenuto del PDF:
${pdfText}
`;

    console.log('Lunghezza del prompt completo:', promptCompleto.length);
    sendMessage(res, 'Invio del prompt completo a Claude');
    sendMessage(res, 'progress:30');

    console.log('Inizio chiamata a OpenAI');
    const completion = await timeoutPromise(
      openai.chat.completions.create({
        model: "anthropic/claude-3-sonnet-20240229",
        messages: [
          { role: "system", content: "Sei un assistente esperto nell'analisi di documenti." },
          { role: "user", content: promptCompleto }
        ],
        timeout: 600000 // 10 minuti
      }),
      600000 // 10 minuti
    );
    console.log('Chiamata a OpenAI completata');

    if (!completion.choices || completion.choices.length === 0) {
      throw new Error("Risposta non valida da OpenAI");
    }

    const testo = completion.choices[0].message.content;
    console.log('Lunghezza della risposta ricevuta:', testo.length);

    sendMessage(res, 'Analisi completata con successo usando Claude 3.5 Sonnet');
    sendMessage(res, 'progress:90');

    const htmlContent = `
<!DOCTYPE html>
<html lang="it">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Sintesi del Capitolato di Gara</title>
    <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 100%; margin: 0 auto; padding: 20px; }
        h1, h2, h3 { color: #2c3e50; margin-top: 20px; margin-bottom: 10px; }
        table { border-collapse: collapse; width: 100%; margin-bottom: 20px; }
        th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
        th { background-color: #f2f2f2; font-weight: bold; }
        table tr:nth-child(even) { background-color: #f9f9f9; }
        table tr:hover { background-color: #f5f5f5; }
    </style>
</head>
<body>
    <h1>Sintesi del Capitolato di Gara</h1>
    ${testo}
</body>
</html>
    `;

    console.log('Elaborazione del documento completata');
    return { htmlContent, modelUsed: "Claude 3.5 Sonnet" };
  } catch (error) {
    console.error('Errore durante l\'elaborazione del documento:', error);
    sendMessage(res, `Errore durante l'elaborazione: ${error.message}`);
    throw error;
  }
}

// Funzione per gestire il timeout manualmente
function timeoutPromise(promise, timeout) {
  return Promise.race([
    promise,
    new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Timeout superato')), timeout)
    )
  ]);
}

async function processFile(file, res) {
  console.log('Inizio elaborazione del file:', file.filename);
  
  try {
    console.log('Inizio estrazione del testo dal PDF');
    const pdfText = await extractTextFromPDF(file.path);
    console.log('Estrazione del testo completata. Lunghezza del testo:', pdfText.length);
    sendMessage(res, 'Estrazione del testo completata');
    
    console.log('Inizio elaborazione del documento completo');
    const result = await elaboraDocumentoCompleto(pdfText, res);
    console.log('Elaborazione del documento completata');
    
    console.log('Inizio generazione del file DOCX');
    const docxPath = await generateDOCX(result.htmlContent);
    console.log('Generazione del file DOCX completata:', docxPath);
    
    sendMessage(res, 'Analisi completata e pronta per il download');
    
    return { fileName: path.basename(docxPath), modelUsed: result.modelUsed };
  } catch (error) {
    console.error('Errore durante l\'elaborazione del file:', error);
    sendMessage(res, `Errore durante l'elaborazione: ${error.message}`);
    throw error;
  }
}

function sendMessage(res, message) {
  if (res.write) {
    res.write(`data: ${message}\n\n`);
    if (res.flush && typeof res.flush === 'function') {
      res.flush();
    }
  } else {
    console.warn('Impossibile inviare il messaggio al client:', message);
  }
}

const frontendPath = path.join(__dirname, '..', 'frontend', 'dist');
app.use(express.static(frontendPath));

app.get('*', (req, res) => {
  res.sendFile(path.join(frontendPath, 'index.html'));
});

const port = process.env.PORT || 3000;
app.listen(port, 'localhost', () => console.log(`Server in ascolto sulla porta ${port} su localhost`));
console.log('Server avviato');

app.get('/api/download/:fileName', async (req, res) => {
  try {
    const fileName = req.params.fileName;
    const filePath = path.join(__dirname, '..', 'uploads', 'docx', fileName);
    
    const stats = await fs.stat(filePath);
    console.log(`Dimensione del file sul server: ${stats.size} bytes`);
    
    res.setHeader('Content-Length', stats.size);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    
    const fileStream = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 }); // 64KB buffer
    
    let bytesSent = 0;
    fileStream.on('data', (chunk) => {
      bytesSent += chunk.length;
      console.log(`Chunk inviato: ${chunk.length} bytes. Totale inviato: ${bytesSent} bytes`);
    });

    fileStream.on('end', () => {
      console.log(`Download completato. Bytes totali inviati: ${bytesSent}`);
      if (bytesSent !== stats.size) {
        console.error(`Discrepanza nella dimensione del file: ${stats.size} vs ${bytesSent}`);
      }
    });

    fileStream.on('error', (error) => {
      console.error('Errore durante lo streaming del file:', error);
      res.status(500).send('Errore durante il download del file');
    });

    res.on('finish', () => {
      console.log('Risposta HTTP completata');
    });

    res.on('close', () => {
      console.log('Connessione chiusa');
      if (bytesSent !== stats.size) {
        console.error('Download interrotto prematuramente');
      }
    });

    await pipeline(fileStream, res);
  } catch (error) {
    console.error('Errore durante il download del file:', error);
    res.status(500).send('Errore durante il download del file');
  }
});

async function extractTextFromPDF(filePath) {
  try {
    const dataBuffer = await fs.readFile(filePath);
    const data = await pdfParse(dataBuffer);
    return data.text;
  } catch (error) {
    console.error('Errore durante l\'estrazione del testo dal PDF:', error);
    throw error;
  }
}

async function generateDOCX(htmlContent) {
  const fileBuffer = await HTMLtoDOCX(htmlContent, null, {
    table: { row: { cantSplit: true } },
    footer: true,
    pageNumber: true,
  });

  const docxFileName = `sintesi_${Date.now()}.docx`;
  const docxPath = path.join(__dirname, '..', 'uploads', 'docx', docxFileName);
  
  await fs.writeFile(docxPath, fileBuffer);
  
  return docxPath;
}