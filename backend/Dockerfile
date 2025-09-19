FROM node:20-alpine

WORKDIR /usr/src/app

# Install build dependencies (untuk native modules)
RUN apk add --no-cache git

# Install package langsung tanpa package.json
RUN npm install  

# Copy source code
COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
