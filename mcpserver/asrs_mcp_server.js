#!/usr/bin/env node

/**
 * ASRS Incident Analyzer Pro - MCP Server
 * 
 * A Model Context Protocol server for analyzing Aviation Safety Reporting System (ASRS)
 * incident data with Human Factors Analysis and Classification System (HFACS) categorizations.
 * 
 * Usage: node asrs_mcp_server.js [path_to_data.json]
 * Default data file: asrs_incidents_with_hfacs.json
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Global data store
let asrsIncidents = [];
let toolRegistry = new Map();

// HFACS taxonomy structure
const HFACS_TAXONOMY = {
  "Level 1: Unsafe Acts of Operators": {
    "Errors": [
      "Skill-Based Errors",
      "Decision Errors", 
      "Perceptual Errors"
    ],
    "Violations": [
      "Routine Violations",
      "Exceptional Violations"
    ]
  },
  "Level 2: Preconditions for Unsafe Acts": {
    "Environmental Factors": [
      "Physical Environment",
      "Technological Environment"
    ],
    "Condition of Operators": [
      "Adverse Mental States",
      "Adverse Physiological States", 
      "Physical/Mental Limitations"
    ],
    "Personnel Factors": [
      "Crew Resource Management (CRM) Issues",
      "Personal Readiness"
    ]
  },
  "Level 3: Unsafe Supervision": {
    "Supervision Issues": [
      "Inadequate Supervision",
      "Planned Inappropriate Operations", 
      "Failure to Correct a Known Problem",
      "Supervisory Violations"
    ]
  },
  "Level 4: Organizational Influences": {
    "Organizational Factors": [
      "Resource Management",
      "Organizational Climate",
      "Operational Process"
    ]
  }
};

/**
 * Helper function to register tools with metadata
 */
function registerTool(name, description, inputSchema) {
  toolRegistry.set(name, {
    name,
    description,
    inputSchema
  });
}

/**
 * Helper function to find incident by ACN
 */
function getIncidentById(acn) {
  return asrsIncidents.find(incident => 
    incident.ACN === acn || incident.acn === acn || String(incident.ACN) === String(acn)
  );
}

/**
 * Helper function to extract narrative text from incident
 */
function findNarrativeText(incident) {
  // Try "Narrative: 1" first
  if (incident["Narrative: 1"] && incident["Narrative: 1"].text) {
    return incident["Narrative: 1"].text;
  }
  
  // Try "Narrative" second
  if (incident["Narrative"] && incident["Narrative"].text) {
    return incident["Narrative"].text;
  }
  
  // Try "Narrative: 2" third
  if (incident["Narrative: 2"] && incident["Narrative: 2"].text) {
    return incident["Narrative: 2"].text;
  }
  
  // Fallback to Synopsis
  if (incident["Synopsis"] && incident["Synopsis"].text) {
    return incident["Synopsis"].text;
  }
  
  return null;
}

/**
 * Helper function to extract and parse date from incident
 */
function parseDateFromIncident(incident) {
  try {
    const timeDay = incident["Time / Day"];
    if (timeDay && timeDay.Date) {
      // Extract YYYYMM from date string like "202301 Local Time..."
      const match = timeDay.Date.match(/^(\d{6})/);
      return match ? match[1] : null;
    }
  } catch (error) {
    console.error(`Error parsing date for incident:`, error);
  }
  return null;
}

/**
 * Helper function to create text snippet with keyword context
 */
function createSnippet(text, keyword, contextLength = 100) {
  const lowerText = text.toLowerCase();
  const lowerKeyword = keyword.toLowerCase();
  const index = lowerText.indexOf(lowerKeyword);
  
  if (index === -1) return text.substring(0, 200) + "...";
  
  const start = Math.max(0, index - contextLength);
  const end = Math.min(text.length, index + keyword.length + contextLength);
  
  let snippet = text.substring(start, end);
  if (start > 0) snippet = "..." + snippet;
  if (end < text.length) snippet = snippet + "...";
  
  return snippet;
}

/**
 * Helper function to escape XML characters
 */
function escapeXml(unsafe) {
  if (unsafe === null || unsafe === undefined) {
    return '';
  }
  if (typeof unsafe !== 'string') {
    unsafe = String(unsafe);
  }
  return unsafe.replace(/[<>&'"]/g, function (c) {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '\'': return '&apos;';
      case '"': return '&quot;';
      default: return c;
    }
  });
}

/**
 * Helper function to convert object to XML
 */
function objectToXml(obj, rootTag = 'result', indent = 0) {
  const indentStr = '  '.repeat(indent);
  let xml = `${indentStr}<${rootTag}>\n`;
  
  for (const [key, value] of Object.entries(obj)) {
    const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, '_');
    
    if (value === null || value === undefined) {
      xml += `${indentStr}  <${safeKey} />\n`;
    } else if (Array.isArray(value)) {
      xml += `${indentStr}  <${safeKey}>\n`;
      value.forEach((item, index) => {
        if (typeof item === 'object' && item !== null) {
          xml += objectToXml(item, 'item', indent + 2);
        } else {
          xml += `${indentStr}    <item>${escapeXml(item)}</item>\n`;
        }
      });
      xml += `${indentStr}  </${safeKey}>\n`;
    } else if (typeof value === 'object' && value !== null) {
      xml += objectToXml(value, safeKey, indent + 1);
    } else {
      xml += `${indentStr}  <${safeKey}>${escapeXml(value)}</${safeKey}>\n`;
    }
  }
  
  xml += `${indentStr}</${rootTag}>\n`;
  return xml;
}

/**
 * Helper function to convert array to XML
 */
function arrayToXml(arr, rootTag = 'results', itemTag = 'item') {
  let xml = `<${rootTag}>\n`;
  arr.forEach(item => {
    if (typeof item === 'object' && item !== null) {
      xml += objectToXml(item, itemTag, 1);
    } else {
      xml += `  <${itemTag}>${escapeXml(item)}</${itemTag}>\n`;
    }
  });
  xml += `</${rootTag}>`;
  return xml;
}

/**
 * Helper function to create error XML
 */
function createErrorXml(message) {
  return `<error>${escapeXml(message)}</error>`;
}

/**
 * Load ASRS incidents data from JSON file
 */
function loadAsrsData(dataPath) {
  try {
    console.error(`Loading ASRS data from: ${dataPath}`);
    const data = fs.readFileSync(dataPath, 'utf8');
    asrsIncidents = JSON.parse(data);
    console.error(`Successfully loaded ${asrsIncidents.length} incidents`);
    
    // Validate data structure
    if (!Array.isArray(asrsIncidents)) {
      throw new Error('Data file must contain an array of incidents');
    }
    
    // Log sample of loaded data for verification
    if (asrsIncidents.length > 0) {
      const sample = asrsIncidents[0];
      console.error(`Sample incident keys: ${Object.keys(sample).join(', ')}`);
      if (sample.hfacs_classification) {
        console.error(`HFACS classifications found: ${sample.hfacs_classification.length} entries`);
      }
    }
    
  } catch (error) {
    console.error(`Error loading ASRS data: ${error.message}`);
    process.exit(1);
  }
}

// Create the MCP server
const server = new Server(
  {
    name: "asrs-incident-analyzer-pro",
    version: "1.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Tool: list_available_tools
registerTool("list_available_tools", "Lists all available tools on this server with their descriptions and expected parameters.", {
  type: "object",
  properties: {},
  additionalProperties: false
});

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: Array.from(toolRegistry.values())
  };
});

// Tool handlers
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: params } = request.params;

  try {
    switch (name) {
      case "list_available_tools": {
        const tools = Array.from(toolRegistry.values());
        const xml = arrayToXml(tools, 'available_tools', 'tool');
        return {
          content: [{
            type: "text",
            text: xml
          }]
        };
      }

      case "get_incident_details": {
        const { acn } = params;
        if (!acn) {
          return {
            content: [{
              type: "text",
              text: createErrorXml("ACN parameter is required")
            }]
          };
        }

        const incident = getIncidentById(acn);
        if (!incident) {
          return {
            content: [{
              type: "text", 
              text: createErrorXml(`Incident with ACN ${acn} not found`)
            }]
          };
        }

        const xml = objectToXml(incident, 'incident');
        return {
          content: [{
            type: "text",
            text: xml
          }]
        };
      }

      case "get_hfacs_classification": {
        const { acn } = params;
        if (!acn) {
          return {
            content: [{
              type: "text",
              text: createErrorXml("ACN parameter is required")
            }]
          };
        }

        const incident = getIncidentById(acn);
        if (!incident) {
          return {
            content: [{
              type: "text",
              text: createErrorXml(`Incident with ACN ${acn} not found`)
            }]
          };
        }

        const hfacsClassification = incident.hfacs_classification || [];
        const result = {
          acn: acn,
          hfacs_classification: hfacsClassification
        };
        const xml = objectToXml(result, 'hfacs_result');
        
        return {
          content: [{
            type: "text",
            text: xml
          }]
        };
      }

      case "list_incidents_by_hfacs": {
        const { 
          hfacs_level, 
          hfacs_category, 
          hfacs_sub_category, 
          match_all_criteria = true, 
          max_results = 10 
        } = params;

        const matchingIncidents = asrsIncidents.filter(incident => {
          if (!incident.hfacs_classification || !Array.isArray(incident.hfacs_classification)) {
            return false;
          }

          return incident.hfacs_classification.some(hfacs => {
            const levelMatch = !hfacs_level || 
              (hfacs.level && hfacs.level.toLowerCase().includes(hfacs_level.toLowerCase()));
            const categoryMatch = !hfacs_category || 
              (hfacs.category && hfacs.category.toLowerCase().includes(hfacs_category.toLowerCase()));
            const subCategoryMatch = !hfacs_sub_category || 
              (hfacs.sub_category && hfacs.sub_category.toLowerCase().includes(hfacs_sub_category.toLowerCase()));

            if (match_all_criteria) {
              return levelMatch && categoryMatch && subCategoryMatch;
            } else {
              return levelMatch || categoryMatch || subCategoryMatch;
            }
          });
        });

        const results = matchingIncidents
          .slice(0, max_results)
          .map(incident => incident.ACN || incident.acn);

        const result = {
          criteria: { hfacs_level, hfacs_category, hfacs_sub_category, match_all_criteria },
          total_matches: matchingIncidents.length,
          returned_count: results.length,
          acns: results
        };
        
        const xml = objectToXml(result, 'hfacs_search_results');
        return {
          content: [{
            type: "text",
            text: xml
          }]
        };
      }

      case "get_incident_narrative": {
        const { acn } = params;
        if (!acn) {
          return {
            content: [{
              type: "text",
              text: createErrorXml("ACN parameter is required")
            }]
          };
        }

        const incident = getIncidentById(acn);
        if (!incident) {
          return {
            content: [{
              type: "text",
              text: createErrorXml(`Incident with ACN ${acn} not found`)
            }]
          };
        }

        const narrative = findNarrativeText(incident);
        const result = {
          acn: acn,
          narrative: narrative || "No narrative text found"
        };
        
        const xml = objectToXml(result, 'narrative_result');
        return {
          content: [{
            type: "text",
            text: xml
          }]
        };
      }

      case "search_incidents_by_keyword": {
        const { 
          keyword, 
          search_in_narrative = true, 
          search_in_synopsis = true, 
          max_results = 5 
        } = params;

        if (!keyword) {
          return {
            content: [{
              type: "text",
              text: createErrorXml("Keyword parameter is required")
            }]
          };
        }

        const lowerKeyword = keyword.toLowerCase();
        const matchingIncidents = [];

        for (const incident of asrsIncidents) {
          let found = false;
          let matchText = "";

          if (search_in_narrative) {
            const narrative = findNarrativeText(incident);
            if (narrative && narrative.toLowerCase().includes(lowerKeyword)) {
              found = true;
              matchText = createSnippet(narrative, keyword);
            }
          }

          if (!found && search_in_synopsis) {
            const synopsis = incident.Synopsis && incident.Synopsis.text;
            if (synopsis && synopsis.toLowerCase().includes(lowerKeyword)) {
              found = true;
              matchText = createSnippet(synopsis, keyword);
            }
          }

          if (found) {
            matchingIncidents.push({
              acn: incident.ACN || incident.acn,
              snippet: matchText
            });

            if (matchingIncidents.length >= max_results) {
              break;
            }
          }
        }

        const result = {
          keyword: keyword,
          search_options: { search_in_narrative, search_in_synopsis },
          total_matches: matchingIncidents.length,
          results: matchingIncidents
        };
        
        const xml = objectToXml(result, 'keyword_search_results');
        return {
          content: [{
            type: "text",
            text: xml
          }]
        };
      }

      case "list_incidents_by_date_range": {
        const { start_date_yyyymm, end_date_yyyymm, max_results = 10 } = params;

        if (!start_date_yyyymm || !end_date_yyyymm) {
          return {
            content: [{
              type: "text",
              text: createErrorXml("Both start_date_yyyymm and end_date_yyyymm are required")
            }]
          };
        }

        // Validate date format
        const dateRegex = /^\d{6}$/;
        if (!dateRegex.test(start_date_yyyymm) || !dateRegex.test(end_date_yyyymm)) {
          return {
            content: [{
              type: "text",
              text: createErrorXml("Date format must be YYYYMM")
            }]
          };
        }

        if (start_date_yyyymm > end_date_yyyymm) {
          return {
            content: [{
              type: "text",
              text: createErrorXml("start_date_yyyymm must be <= end_date_yyyymm")
            }]
          };
        }

        const matchingIncidents = asrsIncidents.filter(incident => {
          const incidentDate = parseDateFromIncident(incident);
          return incidentDate && 
                 incidentDate >= start_date_yyyymm && 
                 incidentDate <= end_date_yyyymm;
        });

        const results = matchingIncidents
          .slice(0, max_results)
          .map(incident => incident.ACN || incident.acn);

        const result = {
          date_range: { start_date_yyyymm, end_date_yyyymm },
          total_matches: matchingIncidents.length,
          returned_count: results.length,
          acns: results
        };
        
        const xml = objectToXml(result, 'date_range_search_results');
        return {
          content: [{
            type: "text",
            text: xml
          }]
        };
      }

      case "get_hfacs_taxonomy": {
        const xml = objectToXml(HFACS_TAXONOMY, 'hfacs_taxonomy');
        return {
          content: [{
            type: "text",
            text: xml
          }]
        };
      }

      case "explore_incidents_by_description_keywords": {
        const { 
          description_keywords, 
          aircraft_type_contains = "", 
          phase_of_flight_contains = "", 
          year_yyyymm = "", 
          max_results = 5 
        } = params;

        if (!description_keywords) {
          return {
            content: [{
              type: "text",
              text: createErrorXml("description_keywords parameter is required")
            }]
          };
        }

        // Tokenize keywords
        const keywords = description_keywords.toLowerCase().split(/\s+/).filter(k => k.length > 0);
        
        const matchingIncidents = [];
        
        for (const incident of asrsIncidents) {
          // Check narrative and synopsis for keywords
          const narrative = findNarrativeText(incident);
          const synopsis = incident.Synopsis && incident.Synopsis.text;
          
          const narrativeText = (narrative || "").toLowerCase();
          const synopsisText = (synopsis || "").toLowerCase();
          
          // Check if ALL keywords are present in either narrative OR synopsis
          const keywordsMatch = keywords.every(keyword => 
            narrativeText.includes(keyword) || synopsisText.includes(keyword)
          );
          
          if (!keywordsMatch) continue;
          
          // Apply optional filters
          
          // Aircraft type filter
          if (aircraft_type_contains) {
            let aircraftTypeMatch = false;
            // Check both "Aircraft" and "Aircraft : 1" patterns
            const aircraftFields = ["Aircraft", "Aircraft : 1"];
            
            for (const field of aircraftFields) {
              if (incident[field] && 
                  incident[field]["Make Model Name"] && 
                  incident[field]["Make Model Name"].toLowerCase().includes(aircraft_type_contains.toLowerCase())) {
                aircraftTypeMatch = true;
                break;
              }
            }
            
            if (!aircraftTypeMatch) continue;
          }
          
          // Phase of flight filter
          if (phase_of_flight_contains) {
            let phaseMatch = false;
            // Check both "Aircraft" and "Aircraft : 1" patterns
            const aircraftFields = ["Aircraft", "Aircraft : 1"];
            
            for (const field of aircraftFields) {
              if (incident[field] && 
                  incident[field]["Flight Phase"] && 
                  incident[field]["Flight Phase"].toLowerCase().includes(phase_of_flight_contains.toLowerCase())) {
                phaseMatch = true;
                break;
              }
            }
            
            if (!phaseMatch) continue;
          }
          
          // Year filter
          if (year_yyyymm) {
            const incidentDate = parseDateFromIncident(incident);
            if (!incidentDate || !incidentDate.startsWith(year_yyyymm)) continue;
          }
          
          // Create snippet with keyword context
          const textToUse = narrative || synopsis || "";
          let snippet = "";
          
          // Find the first keyword match to create snippet around
          for (const keyword of keywords) {
            if (textToUse.toLowerCase().includes(keyword)) {
              snippet = createSnippet(textToUse, keyword);
              break;
            }
          }
          
          // If no specific keyword found for snippet, use the beginning
          if (!snippet && textToUse) {
            snippet = textToUse.substring(0, 200) + "...";
          }
          
          matchingIncidents.push({
            acn: incident.ACN || incident.acn,
            snippet: snippet
          });
          
          if (matchingIncidents.length >= max_results) {
            break;
          }
        }
        
        const result = {
          search_criteria: {
            description_keywords,
            aircraft_type_contains,
            phase_of_flight_contains,
            year_yyyymm
          },
          total_matches: matchingIncidents.length,
          results: matchingIncidents
        };
        
        const xml = objectToXml(result, 'keyword_description_search_results');
        return {
          content: [{
            type: "text",
            text: xml
          }]
        };
      }

      case "find_similar_incidents": {
        const {
          primary_acn,
          similarity_criteria,
          min_hfacs_matches = 1,
          max_results = 3
        } = params;
        
        if (!primary_acn || !similarity_criteria || !Array.isArray(similarity_criteria)) {
          return {
            content: [{
              type: "text",
              text: createErrorXml("primary_acn and similarity_criteria (array) are required")
            }]
          };
        }
        
        // Get primary incident
        const primaryIncident = getIncidentById(primary_acn);
        if (!primaryIncident) {
          return {
            content: [{
              type: "text",
              text: createErrorXml(`Primary incident with ACN ${primary_acn} not found`)
            }]
          };
        }
        
        // Extract primary incident characteristics based on criteria
        const primaryCharacteristics = {};
        
        // HFACS classifications
        if (similarity_criteria.includes("hfacs_top_level") || 
            similarity_criteria.includes("hfacs_category") || 
            similarity_criteria.includes("hfacs_sub_category")) {
          
          if (!primaryIncident.hfacs_classification || !Array.isArray(primaryIncident.hfacs_classification)) {
            return {
              content: [{
                type: "text",
                text: createErrorXml(`Primary incident with ACN ${primary_acn} has no HFACS classifications`)
              }]
            };
          }
          
          primaryCharacteristics.hfacs_top_level = new Set();
          primaryCharacteristics.hfacs_category = new Set();
          primaryCharacteristics.hfacs_sub_category = new Set();
          
          primaryIncident.hfacs_classification.forEach(hfacs => {
            if (hfacs.level) primaryCharacteristics.hfacs_top_level.add(hfacs.level.toLowerCase());
            if (hfacs.category) primaryCharacteristics.hfacs_category.add(hfacs.category.toLowerCase());
            if (hfacs.sub_category) primaryCharacteristics.hfacs_sub_category.add(hfacs.sub_category.toLowerCase());
          });
        }
        
        // Aircraft type
        if (similarity_criteria.includes("aircraft_type")) {
          const aircraftFields = ["Aircraft", "Aircraft : 1"];
          for (const field of aircraftFields) {
            if (primaryIncident[field] && primaryIncident[field]["Make Model Name"]) {
              primaryCharacteristics.aircraft_type = primaryIncident[field]["Make Model Name"].toLowerCase();
              break;
            }
          }
          
          if (!primaryCharacteristics.aircraft_type) {
            return {
              content: [{
                type: "text",
                text: createErrorXml(`Primary incident with ACN ${primary_acn} has no aircraft type information`)
              }]
            };
          }
        }
        
        // Phase of flight
        if (similarity_criteria.includes("phase_of_flight")) {
          const aircraftFields = ["Aircraft", "Aircraft : 1"];
          for (const field of aircraftFields) {
            if (primaryIncident[field] && primaryIncident[field]["Flight Phase"]) {
              primaryCharacteristics.phase_of_flight = primaryIncident[field]["Flight Phase"].toLowerCase();
              break;
            }
          }
          
          if (!primaryCharacteristics.phase_of_flight) {
            return {
              content: [{
                type: "text",
                text: createErrorXml(`Primary incident with ACN ${primary_acn} has no flight phase information`)
              }]
            };
          }
        }
        
        // Find similar incidents
        const similarIncidents = [];
        
        for (const incident of asrsIncidents) {
          // Skip the primary incident itself
          const currentAcn = incident.ACN || incident.acn;
          if (String(currentAcn) === String(primary_acn)) {
            continue;
          }
          
          // Track similarity reasons
          const similarityReasons = [];
          let allCriteriaMet = true;
          
          // Check HFACS matches
          for (const hfacsType of ["hfacs_top_level", "hfacs_category", "hfacs_sub_category"]) {
            if (similarity_criteria.includes(hfacsType)) {
              if (!incident.hfacs_classification || !Array.isArray(incident.hfacs_classification)) {
                allCriteriaMet = false;
                break;
              }
              
              const comparisonSet = primaryCharacteristics[hfacsType];
              const matchCount = incident.hfacs_classification.reduce((count, hfacs) => {
                const fieldName = hfacsType.replace("hfacs_", "");
                if (hfacs[fieldName] && comparisonSet.has(hfacs[fieldName].toLowerCase())) {
                  return count + 1;
                }
                return count;
              }, 0);
              
              if (matchCount < min_hfacs_matches) {
                allCriteriaMet = false;
                break;
              }
              
              similarityReasons.push(`Shares ${matchCount} ${hfacsType.replace('hfacs_', '')} HFACS classifications`);
            }
          }
          
          if (!allCriteriaMet) continue;
          
          // Check aircraft type
          if (similarity_criteria.includes("aircraft_type")) {
            let hasMatch = false;
            const aircraftFields = ["Aircraft", "Aircraft : 1"];
            
            for (const field of aircraftFields) {
              if (incident[field] && 
                  incident[field]["Make Model Name"] && 
                  incident[field]["Make Model Name"].toLowerCase() === primaryCharacteristics.aircraft_type) {
                hasMatch = true;
                similarityReasons.push("Same aircraft type");
                break;
              }
            }
            
            if (!hasMatch) {
              allCriteriaMet = false;
              continue;
            }
          }
          
          // Check phase of flight
          if (similarity_criteria.includes("phase_of_flight")) {
            let hasMatch = false;
            const aircraftFields = ["Aircraft", "Aircraft : 1"];
            
            for (const field of aircraftFields) {
              if (incident[field] && 
                  incident[field]["Flight Phase"] && 
                  incident[field]["Flight Phase"].toLowerCase() === primaryCharacteristics.phase_of_flight) {
                hasMatch = true;
                similarityReasons.push("Same flight phase");
                break;
              }
            }
            
            if (!hasMatch) {
              allCriteriaMet = false;
              continue;
            }
          }
          
          if (allCriteriaMet) {
            similarIncidents.push({
              acn: currentAcn,
              similarity_reason: similarityReasons.join("; ")
            });
            
            if (similarIncidents.length >= max_results) {
              break;
            }
          }
        }
        
        const result = {
          primary_acn,
          similarity_criteria,
          total_matches: similarIncidents.length,
          similar_incidents: similarIncidents
        };
        
        const xml = objectToXml(result, 'similar_incidents_results');
        return {
          content: [{
            type: "text",
            text: xml
          }]
        };
      }

      case "get_incidents_by_structured_data": {
        const {
          aircraft_operator_contains = "",
          flight_phase_exact = "",
          environment_flight_conditions_exact = "",
          location_airport_code_exact = "",
          anomaly_type_contains = "",
          max_results = 10
        } = params;
        
        // At least one filter should be provided
        if (!aircraft_operator_contains && 
            !flight_phase_exact && 
            !environment_flight_conditions_exact && 
            !location_airport_code_exact && 
            !anomaly_type_contains) {
          return {
            content: [{
              type: "text",
              text: createErrorXml("At least one filter criterion must be provided")
            }]
          };
        }
        
        const matchingIncidents = [];
        
        for (const incident of asrsIncidents) {
          let allCriteriaMet = true;
          
          // Check aircraft operator
          if (aircraft_operator_contains) {
            let hasMatch = false;
            const aircraftFields = ["Aircraft", "Aircraft : 1"];
            
            for (const field of aircraftFields) {
              if (incident[field] && 
                  incident[field]["Aircraft Operator"] && 
                  incident[field]["Aircraft Operator"].toLowerCase().includes(aircraft_operator_contains.toLowerCase())) {
                hasMatch = true;
                break;
              }
            }
            
            if (!hasMatch) {
              allCriteriaMet = false;
              continue;
            }
          }
          
          // Check flight phase
          if (flight_phase_exact) {
            let hasMatch = false;
            const aircraftFields = ["Aircraft", "Aircraft : 1"];
            
            for (const field of aircraftFields) {
              if (incident[field] && 
                  incident[field]["Flight Phase"] && 
                  incident[field]["Flight Phase"].toLowerCase() === flight_phase_exact.toLowerCase()) {
                hasMatch = true;
                break;
              }
            }
            
            if (!hasMatch) {
              allCriteriaMet = false;
              continue;
            }
          }
          
          // Check environment flight conditions
          if (environment_flight_conditions_exact) {
            let hasMatch = false;
            const envFields = ["Environment", "Environment : 1"];
            
            for (const field of envFields) {
              if (incident[field] && 
                  incident[field]["Flight Conditions"] && 
                  incident[field]["Flight Conditions"].toLowerCase() === environment_flight_conditions_exact.toLowerCase()) {
                hasMatch = true;
                break;
              }
            }
            
            if (!hasMatch) {
              allCriteriaMet = false;
              continue;
            }
          }
          
          // Check location airport code
          if (location_airport_code_exact) {
            let hasMatch = false;
            const placeFields = ["Place", "Place : 1"];
            
            for (const field of placeFields) {
              if (incident[field] && 
                  incident[field]["Locale Reference"] && 
                  incident[field]["Locale Reference"]["Airport"] && 
                  incident[field]["Locale Reference"]["Airport"].toLowerCase() === location_airport_code_exact.toLowerCase()) {
                hasMatch = true;
                break;
              }
            }
            
            if (!hasMatch) {
              allCriteriaMet = false;
              continue;
            }
          }
          
          // Check anomaly type
          if (anomaly_type_contains) {
            let hasMatch = false;
            
            if (incident.Events) {
              for (const key of Object.keys(incident.Events)) {
                if (key.startsWith("Anomaly") && 
                    incident.Events[key] && 
                    incident.Events[key].toLowerCase().includes(anomaly_type_contains.toLowerCase())) {
                  hasMatch = true;
                  break;
                }
              }
            }
            
            if (!hasMatch) {
              allCriteriaMet = false;
              continue;
            }
          }
          
          if (allCriteriaMet) {
            matchingIncidents.push(incident.ACN || incident.acn);
            
            if (matchingIncidents.length >= max_results) {
              break;
            }
          }
        }
        
        const result = {
          criteria: {
            aircraft_operator_contains,
            flight_phase_exact,
            environment_flight_conditions_exact,
            location_airport_code_exact,
            anomaly_type_contains
          },
          total_matches: matchingIncidents.length,
          acns: matchingIncidents
        };
        
        const xml = objectToXml(result, 'structured_data_search_results');
        return {
          content: [{
            type: "text",
            text: xml
          }]
        };
      }

      case "get_hfacs_statistics_summary": {
        const {
          statistic_level = "category",
          top_n = 5,
          filter_start_date_yyyymm = "",
          filter_end_date_yyyymm = "",
          filter_aircraft_type_contains = ""
        } = params;
        
        // Validate statistic_level
        if (!["level", "category", "sub_category"].includes(statistic_level)) {
          return {
            content: [{
              type: "text",
              text: createErrorXml("statistic_level must be one of: level, category, sub_category")
            }]
          };
        }
        
        // Filter incidents if needed
        let filteredIncidents = asrsIncidents;
        
        // Date range filter
        if (filter_start_date_yyyymm && filter_end_date_yyyymm) {
          // Validate date format
          const dateRegex = /^\d{6}$/;
          if (!dateRegex.test(filter_start_date_yyyymm) || !dateRegex.test(filter_end_date_yyyymm)) {
            return {
              content: [{
                type: "text",
                text: createErrorXml("Date format must be YYYYMM")
              }]
            };
          }
          
          if (filter_start_date_yyyymm > filter_end_date_yyyymm) {
            return {
              content: [{
                type: "text",
                text: createErrorXml("filter_start_date_yyyymm must be <= filter_end_date_yyyymm")
              }]
            };
          }
          
          filteredIncidents = filteredIncidents.filter(incident => {
            const incidentDate = parseDateFromIncident(incident);
            return incidentDate && 
                   incidentDate >= filter_start_date_yyyymm && 
                   incidentDate <= filter_end_date_yyyymm;
          });
        }
        
        // Aircraft type filter
        if (filter_aircraft_type_contains) {
          filteredIncidents = filteredIncidents.filter(incident => {
            const aircraftFields = ["Aircraft", "Aircraft : 1"];
            for (const field of aircraftFields) {
              if (incident[field] && 
                  incident[field]["Make Model Name"] && 
                  incident[field]["Make Model Name"].toLowerCase().includes(filter_aircraft_type_contains.toLowerCase())) {
                return true;
              }
            }
            return false;
          });
        }
        
        // Count HFACS items
        const hfacsItemCounts = new Map();
        let totalIncidentsWithHfacs = 0;
        
        for (const incident of filteredIncidents) {
          if (incident.hfacs_classification && Array.isArray(incident.hfacs_classification)) {
            totalIncidentsWithHfacs++;
            
            for (const hfacs of incident.hfacs_classification) {
              const item = hfacs[statistic_level];
              if (item) {
                const key = item.toLowerCase();
                hfacsItemCounts.set(key, (hfacsItemCounts.get(key) || 0) + 1);
              }
            }
          }
        }
        
        // Sort and get top N
        const sortedItems = Array.from(hfacsItemCounts.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, top_n)
          .map(([item, count]) => ({
            item: item,
            count: count,
            percentage: totalIncidentsWithHfacs ? (count / totalIncidentsWithHfacs * 100).toFixed(2) + "%" : "0%"
          }));
        
        const result = {
          statistic_level,
          filter: {
            start_date: filter_start_date_yyyymm || "none",
            end_date: filter_end_date_yyyymm || "none",
            aircraft_type: filter_aircraft_type_contains || "none"
          },
          total_incidents_in_filter: filteredIncidents.length,
          incidents_with_hfacs: totalIncidentsWithHfacs,
          top_items: sortedItems
        };
        
        const xml = objectToXml(result, 'hfacs_statistics');
        return {
          content: [{
            type: "text",
            text: xml
          }]
        };
      }

      default:
        return {
          content: [{
            type: "text",
            text: createErrorXml(`Unknown tool: ${name}`)
          }],
          isError: true
        };
    }
  } catch (error) {
    console.error(`Error in tool ${name}:`, error);
    return {
      content: [{
        type: "text",
        text: createErrorXml(`Error executing tool ${name}: ${error.message}`)
      }],
      isError: true
    };
  }
});

// Register all tools with their schemas
registerTool("get_incident_details", "Retrieves the full details of an ASRS incident report given its ACN.", {
  type: "object",
  properties: {
    acn: {
      type: "string",
      description: "The ACN of the incident."
    }
  },
  required: ["acn"]
});

registerTool("get_hfacs_classification", "Retrieves the pre-computed HFACS classification for a given ASRS incident ACN.", {
  type: "object", 
  properties: {
    acn: {
      type: "string",
      description: "The ACN of the incident."
    }
  },
  required: ["acn"]
});

registerTool("list_incidents_by_hfacs", "Lists ACNs of incidents matching specific HFACS criteria.", {
  type: "object",
  properties: {
    hfacs_level: {
      type: "string",
      description: "e.g., 'Unsafe Acts of Operators'. Optional."
    },
    hfacs_category: {
      type: "string", 
      description: "e.g., 'Errors'. Optional."
    },
    hfacs_sub_category: {
      type: "string",
      description: "e.g., 'Skill-Based Errors'. Optional."
    },
    match_all_criteria: {
      type: "boolean",
      description: "If true, all provided HFACS criteria must match within a single HFACS entry. Default: true.",
      default: true
    },
    max_results: {
      type: "number",
      description: "Maximum ACNs to return.",
      default: 10
    }
  }
});

registerTool("get_incident_narrative", "Retrieves the primary narrative text for a given ASRS incident ACN.", {
  type: "object",
  properties: {
    acn: {
      type: "string", 
      description: "The ACN of the incident."
    }
  },
  required: ["acn"]
});

registerTool("search_incidents_by_keyword", "Searches incident narratives and synopses for keywords.", {
  type: "object",
  properties: {
    keyword: {
      type: "string",
      description: "Keyword/phrase (case-insensitive)."
    },
    search_in_narrative: {
      type: "boolean",
      description: "Search main narratives. Default: true.",
      default: true
    },
    search_in_synopsis: {
      type: "boolean", 
      description: "Search synopsis. Default: true.",
      default: true
    },
    max_results: {
      type: "number",
      description: "Max incidents to return.",
      default: 5
    }
  },
  required: ["keyword"]
});

registerTool("list_incidents_by_date_range", "Lists ACNs of incidents within a YYYYMM date range.", {
  type: "object",
  properties: {
    start_date_yyyymm: {
      type: "string",
      description: "Start date (YYYYMM)."
    },
    end_date_yyyymm: {
      type: "string", 
      description: "End date (YYYYMM)."
    },
    max_results: {
      type: "number",
      description: "Max ACNs to return.",
      default: 10
    }
  },
  required: ["start_date_yyyymm", "end_date_yyyymm"]
});

registerTool("get_hfacs_taxonomy", "Returns the structure of the HFACS framework.", {
  type: "object",
  properties: {},
  additionalProperties: false
});

registerTool("explore_incidents_by_description_keywords", "Allows users to describe a scenario or type of incident in natural language keywords. The server will attempt to find relevant incidents based on keyword matching in narratives and synopses, and then further filter by any specified structured criteria. Returns a list of ACNs and context snippets.", {
  type: "object",
  properties: {
    description_keywords: { 
      type: "string", 
      description: "A string of keywords or a short natural language description of the incident type to search for (e.g., 'runway confusion takeoff night')." 
    },
    aircraft_type_contains: { 
      type: "string", 
      description: "Optional: Text that the 'Aircraft.Make Model Name' field should contain (case-insensitive).", 
      default: "" 
    },
    phase_of_flight_contains: { 
      type: "string", 
      description: "Optional: Text that the 'Aircraft.Flight Phase' field should contain (case-insensitive).", 
      default: "" 
    },
    year_yyyymm: { 
      type: "string", 
      description: "Optional: Filter by year and month (YYYYMM).", 
      default: "" 
    },
    max_results: { 
      type: "number", 
      description: "Maximum ACNs to return.", 
      default: 5 
    }
  },
  required: ["description_keywords"]
});

registerTool("find_similar_incidents", "Given a primary ACN, finds other incidents that share similar characteristics, such as common HFACS classifications, aircraft type, or phase of flight. This helps identify patterns.", {
  type: "object",
  properties: {
    primary_acn: { 
      type: "string", 
      description: "The ACN of the incident to find similarities for." 
    },
    similarity_criteria: {
      type: "array",
      items: { 
        type: "string", 
        enum: ["hfacs_top_level", "hfacs_category", "hfacs_sub_category", "aircraft_type", "phase_of_flight"] 
      },
      description: "List of criteria to match for similarity (e.g., ['hfacs_category', 'aircraft_type'])."
    },
    min_hfacs_matches: { 
      type: "number", 
      description: "Minimum number of HFACS categories/sub-categories to match if HFACS criteria are used. Default 1.", 
      default: 1
    },
    max_results: { 
      type: "number", 
      description: "Maximum similar ACNs to return.", 
      default: 3 
    }
  },
  required: ["primary_acn", "similarity_criteria"]
});

registerTool("get_incidents_by_structured_data", "Retrieves incidents based on various structured data fields like aircraft operator, flight phase, environment, etc., without needing keywords from narratives.", {
  type: "object",
  properties: {
    aircraft_operator_contains: { 
      type: "string", 
      description: "Text the 'Aircraft.Aircraft Operator' field should contain. Optional." 
    },
    flight_phase_exact: { 
      type: "string", 
      description: "Exact match for 'Aircraft.Flight Phase'. Optional." 
    },
    environment_flight_conditions_exact: { 
      type: "string", 
      description: "Exact match for 'Environment.Flight Conditions' (e.g., 'VMC', 'IMC'). Optional." 
    },
    location_airport_code_exact: { 
      type: "string", 
      description: "Exact ICAO/IATA code for 'Place.Locale Reference.Airport' (e.g., 'OKC.Airport'). Optional."
    },
    anomaly_type_contains: { 
      type: "string", 
      description: "Text an 'Events.Anomaly...' field should contain. Optional."
    },
    max_results: { 
      type: "number", 
      description: "Maximum ACNs to return.", 
      default: 10 
    }
  }
});

registerTool("get_hfacs_statistics_summary", "Provides a summary of HFACS classifications across the dataset, like the top N most frequent categories or sub-categories, optionally filtered by date or aircraft type.", {
  type: "object",
  properties: {
    statistic_level: { 
      type: "string", 
      enum: ["level", "category", "sub_category"], 
      description: "The HFACS level to summarize (level, category, or sub_category).", 
      default: "category" 
    },
    top_n: { 
      type: "number", 
      description: "Number of top HFACS items to return.", 
      default: 5 
    },
    filter_start_date_yyyymm: { 
      type: "string", 
      description: "Optional: Start date YYYYMM.", 
      default: "" 
    },
    filter_end_date_yyyymm: { 
      type: "string", 
      description: "Optional: End date YYYYMM.", 
      default: "" 
    },
    filter_aircraft_type_contains: { 
      type: "string", 
      description: "Optional: Filter by aircraft type.", 
      default: "" 
    }
  }
});

// Main execution
async function main() {
  // Determine data file path
  const dataPath = process.argv[2] || path.join(__dirname, 'asrs_incidents_with_hfacs.json');
  
  // Load ASRS data
  loadAsrsData(dataPath);
  
  // Set up transport
  const transport = new StdioServerTransport();
  
  // Start the server
  console.error("Starting ASRS Incident Analyzer Pro MCP Server...");
  await server.connect(transport);
  console.error("Server connected and ready!");
}

// Graceful shutdown handlers
process.on('SIGINT', async () => {
  console.error('Received SIGINT, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.error('Received SIGTERM, shutting down gracefully...');
  process.exit(0);
});

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Start the server
main().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});