# The sign-in backend is dependency-free, so the image is just Node plus three
# source files. No npm install step.
FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY config.js session.js google.js app.js index.js ./

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8787

EXPOSE 8787

CMD ["node", "index.js"]
