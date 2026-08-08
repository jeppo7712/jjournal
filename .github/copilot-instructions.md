# JJournal - AI Coding Instructions

JJournal is a full-stack application for stock and futures trading journaling with AI analysis capabilities. This guide outlines key patterns and workflows to help AI agents be productive in this codebase.

## Architecture Overview

### Frontend (React)
- Entry point: `src/App.jsx` manages the main view state and modal interactions
- Components follow modular structure in `src/components/`
- Context-based state management using `TradeContext` (`src/context/TradeContext.js`)
- Each feature has its own directory with component + CSS module

### Backend (Node.js/Express)
- Entry point: `server.js` handles core server setup and WebSocket integration
- Modular route handlers in `routes/` directory
- Database operations abstracted in `modules/database.js`
- Task management system for background data processing in `modules/task-manager.js`
- Interactive Brokers connection handling in `modules/ibkr-conn.js`

## Key Patterns

### Data Flow
- Frontend components communicate via `TradeContext` provider
- Backend uses WebSocket for real-time status updates (`broadcastStatus` function)
- Historical data processing managed through task queue system
- Account-based routing with `X-Account-ID` header validation

### State Management
- Modal state controlled at App level, passed down via props
- Trade data mutations handled through context actions
- Server maintains task queue state for data processing
- WebSocket used for real-time status updates

### API Routes
- All routes mounted under `/api`
- Route modules follow pattern: `(dependencies) => router`
- Protected routes require `X-Account-ID` header
- Database endpoints check connection status

## Development Workflow

### Starting the Application
```bash
npm run start  # Concurrently runs server and frontend
npm run server # Backend only
npm run app    # Frontend only
```

### Configuration
- Environment variables loaded from `.env` (create from sample)
- Database URL and API keys configured via `/api/config` endpoint
- IBKR connection settings in configuration
- Logging handled by Winston (`modules/logger.js`)

### Data Processing
- Historical data fetched through task queue system
- Cron jobs scheduled for regular data updates
- Task priorities: USER_FOREGROUND > CRON_FULL_POPULATION

## Critical Files
- `server.js`: Core server setup and WebSocket handling
- `src/App.jsx`: Main view management and routing
- `modules/task-manager.js`: Background task processing
- `modules/database.js`: Database operations
- `routes/*.js`: API endpoint implementations