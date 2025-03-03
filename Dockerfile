FROM node:18-alpine

WORKDIR /app

COPY package*.json ./

RUN npm install

RUN npm install mysql2


COPY . .

EXPOSE 8081

CMD ["node", "app.js"]
