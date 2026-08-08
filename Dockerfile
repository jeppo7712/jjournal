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
CMD ["node", "server.js"]
