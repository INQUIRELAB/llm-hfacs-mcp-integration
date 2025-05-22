# 🚀 MCP Bridge & HFACS Server Setup Guide

## 📋 Overview

This repository contains the configuration and setup for running:
- **MCP Bridge**: A RESTful proxy for Model Context Protocol servers
- **HFACS MCP Server**: A specialized server for analyzing aviation safety data
- **LLM Test Client**: A Python client using Google's Gemini LLM for natural language interactions

## 📑 Abstract

Learning effectively from past incidents is crucial for advancing aviation safety, but manually analyzing extensive narrative datasets like the Aviation Safety Reporting System (ASRS) to understand causality is resource-intensive and can be subjective. While Large Language Models (LLMs) offer powerful capabilities for text analysis, their performance can degrade when processing entire large datasets within limited context windows, potentially leading to decreased accuracy and increased hallucination. 

This paper introduces a novel framework to address these challenges by automating the extraction of human factors insights from Oklahoma ASRS records. We employ the API version of OpenAI's o3 reasoning LLM, guided by few-shot prompting, to classify ASRS incident narratives into the Human Factors Analysis and Classification System (HFACS) each record at a time. 

The core of our solution is a specialized Model Context Protocol (MCP) server designed to intelligently serve these ASRS data and their associated HFACS classifications. We enable targeted data retrieval by using MCP which allows the LLM to focus on relevant information from the ASRS corpus without overwhelming its context capacity during complex queries. This server is integrated into a broader ecosystem via the MCP Bridge, an LLM-agnostic RESTful proxy, which further facilitates interaction with diverse clients.

This agent demonstrates the system's capability to perform complex, multi-tool, zero-shot queries to retrieve, compare, and report on incidents based on specific HFACS criteria and keywords. Our approach highlights how combining advanced reasoning LLMs with MCP's targeted data access can significantly enhance the objectivity, depth, and efficiency of post-flight debriefs and safety investigations which creates more transparent and actionable AI-driven safety analysis tools.

## 🔧 Prerequisites

- Node.js (v14+) for running MCP Bridge
- Python 3.8+ for running the LLM test client
- Google API key for Gemini (set as environment variable `GEMINI_API_KEY`)

## ⚙️ Configuration

### Step 1: Configure MCP Servers

Edit the `mcp_config.json` file in the root directory:

```json
{
  "mcpServers": {
    "asrs_analyzer": {
      "command": "node",
      "args": ["scitech/mcpserver/hfacs_server.js"],
      "env": {
        "ASRS_API_KEY": "your_asrs_api_key_here"
      },
      "riskLevel": 1
    }
  }
}
```

Key fields:
- `asrs_analyzer`: A unique identifier for this MCP server
- `command`: The executable to run the server
- `args`: Arguments for the command
- `env`: Environment variables (including API keys)
- `riskLevel`: Security level (1=Low, 2=Medium, 3=High)

### Step 2: Install Dependencies

For MCP Bridge:
```bash
npm install
```

For the LLM test client:
```bash
pip install google-generativeai rich requests
```

### Step 3: Client Options

While this guide uses a Python-based Gemini LLM client for testing, the MCP server architecture supports a wide variety of clients:

- **MCP Bridge** (primary option): The lightweight, LLM-agnostic proxy that connects to multiple MCP servers and exposes their capabilities through a unified REST API. This is the recommended client for most use cases due to its flexibility and minimal dependencies.
  
  **🔗 [MCP Bridge Repository](https://github.com/INQUIRELAB/mcp-bridge-api)**
- **Claude Desktop**: The Anthropic Claude desktop application can connect to MCP servers
- **Claude Code**: Claude's code interpreter can work with MCP
- **Other LLM Agents**: Any client that supports the Model Context Protocol can interact with this system
- **Custom Applications**: Build your own applications using the MCP Bridge API

The flexibility of the MCP architecture allows you to choose the client that best fits your workflow and requirements.

## 🚀 Running the System

### Start MCP Bridge

From the root directory:

```bash
node mcp-bridge.js
```

The bridge will automatically load the server configurations from `mcp_config.json` and start the defined MCP servers.

You should see output similar to:
```
Starting MCP Bridge...
Middleware configured
Loading server configuration...
Loaded 1 server configurations
Initializing MCP servers...
Starting server: asrs_analyzer
Server asrs_analyzer initialized successfully
All servers initialized
MCP Bridge server running on port 3000
Ready to handle requests
```

### Step 3: Run the LLM Test Client

From the root directory:

```bash
python llm_test.py
```

Make sure your `GEMINI_API_KEY` is set in your environment variables:

```bash
# On Windows PowerShell
$env:GEMINI_API_KEY="your_api_key_here"

# On Linux/Mac
export GEMINI_API_KEY="your_api_key_here"
```

## 💬 Testing with the LLM Client

Once the LLM test client is running, you can interact with the HFACS server using natural language queries.

### Example Queries:

1. **Get details about a specific incident**:
   ```
   Can you retrieve the full details for ASRS incident report ACN 1758012?
   ```

2. **Get HFACS classification for a report**:
   ```
   What's the HFACS classification for incident ACN 1122334?
   ```

3. **List the HFACS taxonomy**:
   ```
   Show me the full HFACS taxonomy structure
   ```

## 🔍 Troubleshooting

- **MCP Bridge not starting**: Check Node.js version and ensure all dependencies are installed
- **LLM client errors**: Verify your Gemini API key is correctly set
- **Server not found**: Make sure your `mcp_config.json` is properly configured and the path to the server script is correct
- **Tool execution errors**: Check the console output for specific error messages from the server

## 📊 Architecture

```
┌────────────┐     ┌───────────┐     ┌──────────────┐
│ LLM Client │────▶│ MCP Bridge│────▶│ HFACS Server │
└────────────┘     └───────────┘     └──────────────┘
     ▲                   ▲                  ▲
     │                   │                  │
     ├───────────────────┼──────────────────┘
     │                   │
┌────┴─────┐     ┌──────┴────┐
│ Gemini   │     │ mcp_config│
│ LLM API  │     │  .json    │
└──────────┘     └───────────┘
```

## 📝 Notes

- The MCP Bridge comes from: https://github.com/INQUIRELAB/mcp-bridge-api
- **Any MCP client** can be used with this HFACS MCP server. We chose MCP Bridge for its flexibility, lightweight nature, and minimal dependencies, which gives us the freedom to choose any LLM implementation.
- For production use, consider setting up proper authentication and API key management
- Additional MCP servers can be added to the configuration as needed

## 📜 License

This project is licensed under the MIT License: