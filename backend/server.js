require('dotenv').config();

const express = require('express');
const multer = require('multer');
const fs = require('fs');
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
  console.log('Richiesta di upload ricevuta');
  if (!req.file) {
    console.log('Nessun file nella richiesta');
    return res.status(400).json({ error: 'Nessun file caricato' });
  }
  console.log('File caricato:', req.file.filename);
  
  try {
    // Inizia l'elaborazione del file
    const result = await processFile(req.file, res);
    res.json({ success: true, message: 'File elaborato con successo', result });
  } catch (error) {
    console.error('Errore durante l\'elaborazione del file:', error);
    res.status(500).json({ error: 'Errore durante l\'elaborazione del file', details: error.message });
  }
});

console.log('Express e Multer configurati');

const openai = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
  defaultHeaders: {
    "HTTP-Referer": process.env.YOUR_SITE_URL || "http://localhost:3000",
    "X-Title": process.env.YOUR_SITE_NAME || "Sin-Text",
  }
});

console.log('Client OpenAI inizializzato');

app.use(express.json());
app.use(cors());
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
  sendMessage(res, 'Inizio elaborazione del documento');
  const risultatoParte1 = await elaboraParteConOpenRouter(PROMPT_PARTE_1, pdfText, res, 1);
  const risultatoParte2 = await elaboraParteConOpenRouter(PROMPT_PARTE_2, pdfText, res, 2);
  const risultatoParte3 = await elaboraParteConOpenRouter(PROMPT_PARTE_3, pdfText, res, 3);

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
    ${risultatoParte1.testo}
    ${risultatoParte2.testo}
    ${risultatoParte3.testo}
</body>
</html>
  `;

  return { htmlContent, modelUsed: risultatoParte3.modelUsed };
}

async function processFile(file, res) {
  console.log('Inizio elaborazione del file:', file.filename);
  
  // Estrai il testo dal PDF
  const pdfText = await extractTextFromPDF(file.path);
  
  // Invia aggiornamenti al client
  sendMessage(res, 'Estrazione del testo completata');
  
  // Elabora il documento con OpenRouter
  const result = await elaboraDocumentoCompleto(pdfText, res);
  
  // Genera il documento DOCX
  const docxPath = await generateDOCX(result.htmlContent);
  
  return { fileName: path.basename(docxPath), modelUsed: result.modelUsed };
}

function sendMessage(res, message) {
  res.write(`data: ${JSON.stringify({ message })}\n\n`);
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
    
    const stats = await fs.promises.stat(filePath);
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

async function elaboraParteConOpenRouter(prompt, pdfText, res, partNumber) {
  try {
    sendMessage(res, `Modello scelto per la Parte ${partNumber}: Claude 3.5 Sonnet`);
    sendMessage(res, `progress:${(partNumber - 1) * 30}`);
    
    sendMessage(res, `Invio del Prompt ${partNumber} a Claude`);
    sendMessage(res, `progress:${(partNumber - 1) * 30 + 10}`);
    
    console.log('Prompt inviato:', prompt);
    const completion = await openai.chat.completions.create({
      model: "anthropic/claude-3-sonnet-20240229",
      messages: [
        { role: "system", content: "Sei un assistente esperto nell'analisi di documenti." },
        { role: "user", content: prompt + "\n\nContenuto del PDF:\n" + pdfText }
      ],
    });
    
    console.log('Risposta ricevuta:', completion);
    
    if (!completion.choices || completion.choices.length === 0) {
      throw new Error("Risposta non valida da OpenAI");
    }
    
    sendMessage(res, `Analisi della Parte ${partNumber} completata con successo usando Claude 3.5 Sonnet`);
    sendMessage(res, `progress:${partNumber * 30}`);
    
    return { testo: completion.choices[0].message.content, modelUsed: "Claude 3.5 Sonnet" };
  } catch (error) {
    console.error('Errore durante l\'analisi:', error);
    console.error('Dettagli errore:', JSON.stringify(error, null, 2));
    sendMessage(res, `Errore durante l'analisi della Parte ${partNumber}: ${error.message}`);
    throw error;
  }
}

app.post('/api/process-file', upload.single('file'), async (req, res) => {
  // Logica per processare il file
  // ...
});