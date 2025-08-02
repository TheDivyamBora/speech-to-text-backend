import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import axios from 'axios';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const ASSEMBLY_API_KEY = process.env.ASSEMBLY_API_KEY;

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// Static path setup
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Multer setup
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadPath = 'uploads/';
    if (!fs.existsSync(uploadPath)) fs.mkdirSync(uploadPath);
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const ext = path.extname(file.originalname);
    cb(null, `${file.fieldname}-${timestamp}${ext}`);
  },
});
const upload = multer({ storage });

// Root route
app.get('/', (req, res) => {
  res.send('🎙️ Speech-to-Text Backend is Running...');
});

// Upload + Transcription route
app.post('/upload', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const filePath = `/uploads/${req.file.filename}`;
    const fullPath = path.join(__dirname, filePath);

    // Step 1: Upload to AssemblyAI
    const audioData = fs.readFileSync(fullPath);
    const uploadResponse = await axios.post(
      'https://api.assemblyai.com/v2/upload',
      audioData,
      {
        headers: {
          authorization: ASSEMBLY_API_KEY,
          'content-type': 'application/octet-stream',
        },
      }
    );

    const audio_url = uploadResponse.data.upload_url;

    // Step 2: Start transcription
    const transcriptResponse = await axios.post(
      'https://api.assemblyai.com/v2/transcript',
      { audio_url },
      {
        headers: {
          authorization: ASSEMBLY_API_KEY,
          'content-type': 'application/json',
        },
      }
    );

    const transcriptId = transcriptResponse.data.id;

    // Step 3: Poll for transcription result
    let completedTranscript = null;
    for (let i = 0; i < 20; i++) {
      const pollingRes = await axios.get(
        `https://api.assemblyai.com/v2/transcript/${transcriptId}`,
        {
          headers: { authorization: ASSEMBLY_API_KEY },
        }
      );

      if (pollingRes.data.status === 'completed') {
        completedTranscript = pollingRes.data;
        break;
      } else if (pollingRes.data.status === 'error') {
        return res.status(500).json({ error: pollingRes.data.error });
      }

      await new Promise((resolve) => setTimeout(resolve, 3000));
    }

    if (!completedTranscript) {
      return res.status(500).json({ error: 'Transcription timed out' });
    }

    const transcriptionText = completedTranscript.text;

    // Step 4: Store in Supabase
    const { data, error } = await supabase
      .from('transcriptions')
      .insert([
        {
          filename: req.file.originalname,
          filepath: filePath,
          transcription: transcriptionText,
        },
      ]);

    if (error) {
      console.error('Supabase insert error:', error);
      return res.status(500).json({ error: 'Failed to insert into Supabase' });
    }

    // ✅ Step 5: Return transcription to frontend
    res.status(200).json({
      message: '✅ File uploaded, transcribed, and saved.',
      transcription: transcriptionText,
    });

  } catch (error) {
    console.error('Upload Error:', error?.response?.data || error.message || error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});