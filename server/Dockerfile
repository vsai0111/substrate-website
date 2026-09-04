# Use Node.js as the runtime
FROM node:22-alpine

# Set the working directory
WORKDIR /app

# Copy dependency definitions first
COPY package*.json ./

# Install production dependencies
RUN npm ci --omit=dev

# Copy the backend source code
COPY . .

# The Express API listens on port 4000
EXPOSE 4000

# Start the API
CMD ["npm", "start"]