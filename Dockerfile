FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY letterboxd.py server.py ./
COPY static ./static

ENV PORT=7860
EXPOSE 7860

CMD ["sh", "-c", "python server.py --port ${PORT:-7860}"]
