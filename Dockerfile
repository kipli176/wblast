FROM node:18

WORKDIR /usr/src/app

# Copy package.json dan install deps
COPY package*.json ./
RUN npm install

# Copy seluruh source code
COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
