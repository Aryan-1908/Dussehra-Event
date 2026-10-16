FROM python:3.11-slim
WORKDIR /app
RUN pip install --no-cache-dir aiohttp==3.9.5
COPY server.py shim.js ravan-dahan.html ./
ENV PORT=8000
# Set HOST_KEY to a secret of your choice; the host opens https://<domain>/?host=<HOST_KEY>
# Mount a volume on /app/data to keep the leaderboard across restarts.
VOLUME /app/data
EXPOSE 8000
CMD ["python", "server.py"]
