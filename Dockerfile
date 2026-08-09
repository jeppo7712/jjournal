FROM node:20-alpine
ENV NODE_ENV=production
ENV REACT_APP_API_URL=
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
RUN npm run build
EXPOSE 3999
ENV USER_PATH=/user_data
# Rebuilding a symbol's continuous series (modules/historical-data-service.js,
# _buildAndStoreContinuousSeries) has to hold that symbol's entire raw
# history in memory at once to run the rollover-detection algorithm. For a
# high-frequency timeframe on a symbol with a lot of history (e.g. CL 1M,
# which uses all 12 contract months/year and had 10M+ rows), that legitimately
# exceeds V8's default ~4GB heap and crashes the process. Raising the heap
# limit isn't a fix for the underlying "loads everything at once" design —
# that would need the algorithm to stream instead — but it's a safe, low-risk
# mitigation given the host has RAM to spare. Adjust if the host's available
# memory changes.
ENV NODE_OPTIONS=--max-old-space-size=8192
CMD ["node", "server.js"]
