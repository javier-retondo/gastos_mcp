FROM node:22-bookworm

WORKDIR /app

# OCR + PDF text extraction
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     tesseract-ocr tesseract-ocr-spa poppler-utils \
  && rm -rf /var/lib/apt/lists/*

# Codex CLI
RUN npm install -g @openai/codex

CMD ["bash", "-lc", "node server.js"]
