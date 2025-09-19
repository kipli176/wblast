FROM node:20-slim

# Set workdir
WORKDIR /usr/src/app

# RUN apk add --no-cache python3 make g++
# Install dependencies
COPY package*.json ./
RUN  npm init -y && npm install

# Copy source code
COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
