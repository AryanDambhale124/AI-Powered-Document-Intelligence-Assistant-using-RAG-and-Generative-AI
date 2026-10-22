# DocuMind AI

Run the web app and local backend on your computer. The backend uses Gemini's free API tier for embeddings and answers, so no paid Firebase deployment or local model download is required. Free-tier quotas and availability depend on Google's current terms. Document text and questions are sent to Google Gemini for processing.

## Start locally

1. Create a Gemini API key in [Google AI Studio](https://aistudio.google.com/apikey). Do not reuse a key that has been committed or shared.
2. In the project folder, install dependencies and create your private local settings file:

   ```powershell
   npm install
   npm --prefix functions install
   Copy-Item .env.local.example .env.local
   ```

3. Open `.env.local` and replace `paste_your_new_key_here` with your API key. This file is ignored by Git and the key stays in the local backend; do not paste the key into frontend code or commit it.
4. In one terminal, start the local backend:

   ```powershell
   npm run local
   ```

5. In a second terminal, start the web app:

   ```powershell
   npm run dev
   ```

6. Open the Vite URL, upload a PDF or TXT file, and ask a question.

If you change the key, restart the backend. The backend listens only on `127.0.0.1`. Uploaded files and chat history are stored under `data/`; delete that folder to remove local data. PDFs must contain selectable text; scanned PDFs are not supported. The upload limit is 5 MB per file.
