# syntax=docker/dockerfile:1
FROM python:3.12-slim

WORKDIR /app

COPY map-tiles-routing-api/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY . /app
EXPOSE 5000

CMD ["python", "map-tiles-routing-api/app.py"]