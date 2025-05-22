import openai
import json
import time
import os
import argparse
from typing import List, Dict, Any, Tuple
import tiktoken # For token counting

# --- Configuration ---
# Load API key from environment variable for security
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY")
MODEL_NAME = "o3-2025-04-16" # As specified by you
REQUEST_DELAY_SECONDS = 1  # Delay between API calls to respect rate limits

# --- HFACS Prompt Template ---
HFACS_PROMPT_TEMPLATE = """
**Project Context & Goal:**

We are working on a project to enhance aviation safety analysis by automating the classification of incident narratives from the Aviation Safety Reporting System (ASRS) into the Human Factors Analysis and Classification System (HFACS) framework. The goal is to improve the efficiency, consistency, and depth of insights gained from post-flight debriefs and safety investigations by systematically identifying human factors contributing to incidents. Your task is to act as an expert aviation safety analyst and classify the provided narrative into the HFACS categories.

**Understanding HFACS:**

HFACS is a hierarchical framework used to identify human error in aviation incidents. It categorizes failures across four main levels:
1.  **Unsafe Acts of Operators:** Errors (Skill-Based, Decision, Perceptual) and Violations (Routine, Exceptional) committed by front-line personnel.
2.  **Preconditions for Unsafe Acts:** Latent conditions in the operator or environment (Environmental Factors: Physical, Technological; Condition of Operators: Adverse Mental/Physiological States, Physical/Mental Limitations; Personnel Factors: CRM, Personal Readiness).
3.  **Unsafe Supervision:** Failures by direct supervisors (Inadequate Supervision, Planned Inappropriate Operations, Failure to Correct Known Problem, Supervisory Violations).
4.  **Organizational Influences:** High-level systemic failures (Resource Management, Organizational Climate, Operational Process).

**Your Task: HFACS Classification for the following narrative:**

Narrative:
---
{narrative_text}
---

Please:
1.  Carefully read and analyze the narrative text provided above.
2.  Identify all relevant contributing factors according to the HFACS framework. An incident can, and often will, have multiple HFACS categories applicable.
3.  For each identified HFACS category, please provide the specific sub-category where possible (e.g., instead of just "Errors," specify "Skill-Based Errors" or "Decision Errors").
4.  Output your classification for THIS SINGLE INCIDENT NARRATIVE in the following JSON format (provide only the JSON list of classifications, nothing else):

**Desired JSON Output Format (a list of classification objects):**
```json
[
  {{
    "level": "Unsafe Acts of Operators",
    "category": "Errors",
    "sub_category": "Skill-Based Errors",
    "justification_from_narrative": "Brief quote or summary from the narrative supporting this classification."
  }},
  {{
    "level": "Preconditions for Unsafe Acts",
    "category": "Environmental Factors",
    "sub_category": "Physical Environment",
    "justification_from_narrative": "Quote/summary supporting this."
  }}
  // ... (more HFACS classifications as applicable for THIS narrative) ...
]
```

**Few-Shot Examples to Guide Your Classification:**

**Example 1:**
*Narrative Snippet:* "During preflight, I misread the fuel gauge due to poor lighting in the hangar and the gauge's small font. I was also feeling rushed because we were behind schedule."
*Expected JSON Output for this example:*
```json
[
  {{
    "level": "Unsafe Acts of Operators",
    "category": "Errors",
    "sub_category": "Perceptual Errors",
    "justification_from_narrative": "Pilot misread the fuel gauge."
  }},
  {{
    "level": "Preconditions for Unsafe Acts",
    "category": "Environmental Factors",
    "sub_category": "Physical Environment",
    "justification_from_narrative": "Poor lighting in the hangar."
  }},
  {{
    "level": "Preconditions for Unsafe Acts",
    "category": "Environmental Factors",
    "sub_category": "Technological Environment",
    "justification_from_narrative": "Gauge's small font."
  }},
  {{
    "level": "Preconditions for Unsafe Acts",
    "category": "Condition of Operators",
    "sub_category": "Adverse Mental States",
    "justification_from_narrative": "Feeling rushed because we were behind schedule."
  }}
]
```

**Example 2:**
*Narrative Snippet:* "The company procedure for a go-around was unclear in the ops manual, and my First Officer seemed hesitant to speak up despite my obvious confusion during the critical phase of flight. Our training on this specific scenario was minimal."
*Expected JSON Output for this example:*
```json
[
  {{
    "level": "Unsafe Acts of Operators",
    "category": "Errors",
    "sub_category": "Decision Errors",
    "justification_from_narrative": "Obvious confusion during a critical phase implies difficulty in decision-making."
  }},
  {{
    "level": "Preconditions for Unsafe Acts",
    "category": "Personnel Factors",
    "sub_category": "Crew Resource Management Issues",
    "justification_from_narrative": "First Officer seemed hesitant to speak up."
  }},
  {{
    "level": "Unsafe Supervision",
    "category": "Inadequate Supervision",
    "justification_from_narrative": "Training on this specific scenario was minimal (implies supervisory oversight of training adequacy)."
  }},
  {{
    "level": "Organizational Influences",
    "category": "Operational Process",
    "justification_from_narrative": "Company procedure for a go-around was unclear in the ops manual."
  }}
]
```

Now, please provide the JSON list of classifications ONLY for the main narrative provided under "Your Task".
"""

# --- Token Counting and Cost Estimation ---
# Pricing for o3-2025-04-16 (as per your information)
INPUT_COST_PER_MILLION_TOKENS = 10.00
OUTPUT_COST_PER_MILLION_TOKENS = 40.00
# Estimate for reasoning tokens: The documentation says it can be "tens of thousands".
# For an estimation, let's assume an average. This is a rough estimate.
# The actual number is in response.usage.output_tokens_details.reasoning_tokens
# For cost estimation, reasoning tokens are billed as output tokens.
# Let's assume an average of 500 output tokens per HFACS classification (including reasoning and actual output).
# This is a very rough guess and can vary wildly.
ESTIMATED_AVERAGE_OUTPUT_TOKENS_PER_CALL = 1000 # Increased estimate, includes reasoning and actual JSON.

def get_tokenizer_for_model(model_name: str) -> tiktoken.Encoding:
    """Returns the tiktoken encoding for the given model."""
    try:
        # For "o3" models, "o200k_base" is likely the correct encoding family
        # based on gpt-4o using it. If OpenAI specifies directly for o3, update this.
        if model_name.startswith("o3") or model_name.startswith("o4"):
             return tiktoken.get_encoding("o200k_base")
        return tiktoken.encoding_for_model(model_name)
    except KeyError:
        print(f"Warning: Model '{model_name}' not found in tiktoken. Using 'o200k_base' as a fallback.")
        return tiktoken.get_encoding("o200k_base")

def count_tokens_for_prompt(prompt_text: str, model_name: str) -> int:
    """Counts the number of tokens for a given prompt text and model."""
    encoder = get_tokenizer_for_model(model_name)
    return len(encoder.encode(prompt_text))

def estimate_cost(num_incidents: int, average_input_tokens_per_incident: int) -> Tuple[float, int, int]:
    """Estimates the cost for processing a number of incidents."""
    total_input_tokens = num_incidents * average_input_tokens_per_incident
    # Reasoning tokens are billed as output tokens.
    # The actual output token count will include both reasoning and the visible completion.
    total_estimated_output_tokens = num_incidents * ESTIMATED_AVERAGE_OUTPUT_TOKENS_PER_CALL

    input_cost = (total_input_tokens / 1_000_000) * INPUT_COST_PER_MILLION_TOKENS
    output_cost = (total_estimated_output_tokens / 1_000_000) * OUTPUT_COST_PER_MILLION_TOKENS
    total_cost = input_cost + output_cost
    return total_cost, total_input_tokens, total_estimated_output_tokens

def find_narrative_field(incident_sample: Dict[str, Any]) -> str:
    """
    Attempts to automatically find the narrative field in an incident sample.
    Prioritizes fields named "Narrative: 1" or containing "Narrative" and having a "text" sub-key.
    """
    if "Narrative: 1" in incident_sample and isinstance(incident_sample["Narrative: 1"], dict) and "text" in incident_sample["Narrative: 1"]:
        return "Narrative: 1"
    for key, value in incident_sample.items():
        if "narrative" in key.lower() and isinstance(value, dict) and "text" in value:
            return key
    # Fallback or further heuristics can be added
    print("Warning: Could not automatically determine the primary narrative field with 'text' subkey.")
    print("Please specify it with --narrative_field. Defaulting to 'Narrative: 1'.")
    return "Narrative: 1"


# --- Main Script ---
def initialize_openai_client():
    """Initializes and returns the OpenAI client."""
    if not OPENAI_API_KEY:
        raise ValueError("OPENAI_API_KEY environment variable not set.")
    return openai.OpenAI(api_key=OPENAI_API_KEY)

def load_incidents(filepath: str) -> List[Dict[str, Any]]:
    """Loads ASRS incidents from a JSON file."""
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            data = json.load(f)
        if not isinstance(data, list):
            raise ValueError("Input JSON file should contain a list of incidents.")
        if not data:
            raise ValueError("Input JSON file is empty.")
        return data
    except FileNotFoundError:
        print(f"Error: Input file '{filepath}' not found.")
        exit(1)
    except json.JSONDecodeError:
        print(f"Error: Could not decode JSON from '{filepath}'. Make sure it's a valid JSON file.")
        exit(1)
    except ValueError as ve:
        print(f"Error: {ve}")
        exit(1)


def save_incidents(filepath: str, data: List[Dict[str, Any]]):
    """Saves the processed incidents (with HFACS classifications) to a JSON file."""
    with open(filepath, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2)
    print(f"\nSuccessfully saved processed incidents to '{filepath}'")

def get_hfacs_classification_from_llm(client: openai.OpenAI, narrative_text: str) -> Tuple[List[Dict[str, Any]], int, int]:
    """
    Sends a narrative to the OpenAI reasoning model and returns the HFACS classification
    along with actual input and output token counts from the API response.
    """
    actual_input_tokens = 0
    actual_output_tokens = 0 # This will include reasoning + completion tokens

    if not narrative_text or not narrative_text.strip():
        print("Warning: Empty narrative text provided. Skipping classification.")
        return [], actual_input_tokens, actual_output_tokens

    full_prompt = HFACS_PROMPT_TEMPLATE.format(narrative_text=narrative_text)
    actual_input_tokens = count_tokens_for_prompt(full_prompt, MODEL_NAME) # Count tokens for the constructed prompt

    try:
        response = client.responses.create(
            model=MODEL_NAME,
            reasoning={"effort": "medium"},
            input=[
                {
                    "role": "user",
                    "content": full_prompt
                }
            ]
        )

        # Extract actual token usage from the API response
        if response.usage:
            # The 'input_tokens' in usage might differ slightly from our tiktoken count due to how API packages requests
            # For cost, API's count is definitive. For our pre-estimation, tiktoken is good.
            # Let's use our tiktoken count for input cost as it's based on the raw prompt.
            # The `response.usage.output_tokens` includes both reasoning and visible completion tokens.
            actual_output_tokens = response.usage.output_tokens or 0


        llm_output_text = response.output_text

        if llm_output_text.strip().startswith("```json"):
            llm_output_text = llm_output_text.split("```json")[1].split("```")[0].strip()
        elif llm_output_text.strip().startswith("```"):
             llm_output_text = llm_output_text.split("```")[1].strip()

        parsed_hfacs = json.loads(llm_output_text)
        if not isinstance(parsed_hfacs, list):
            print(f"Warning: LLM did not return a list for HFACS. Output: {llm_output_text}")
            return [{"error": "LLM did not return a list", "raw_output": llm_output_text}], actual_input_tokens, actual_output_tokens
        return parsed_hfacs, actual_input_tokens, actual_output_tokens

    except json.JSONDecodeError:
        print(f"Error: Could not parse LLM response as JSON. Raw response: {llm_output_text if 'llm_output_text' in locals() else 'N/A'}")
        return [{"error": "Failed to parse LLM JSON response", "raw_output": llm_output_text if 'llm_output_text' in locals() else 'N/A'}], actual_input_tokens, actual_output_tokens
    except openai.APIError as e:
        print(f"OpenAI API Error: {e}")
        return [{"error": f"OpenAI API Error: {str(e)}"}], actual_input_tokens, actual_output_tokens
    except Exception as e:
        print(f"An unexpected error occurred during LLM call: {e}")
        return [{"error": f"Unexpected error: {str(e)}"}], actual_input_tokens, actual_output_tokens

def main():
    parser = argparse.ArgumentParser(description="Classify ASRS incident narratives using HFACS via OpenAI LLM.")
    parser.add_argument("input_file", help="Path to the input JSON file containing ASRS incidents.")
    parser.add_argument("output_file", help="Path to save the output JSON file with HFACS classifications.")
    parser.add_argument("--narrative_field", default=None,
                        help="The field name in each JSON incident object that contains the narrative text. (default: auto-detected)")
    parser.add_argument("--start_index", type=int, default=0, help="Index of the incident to start processing from (0-based).")
    parser.add_argument("--end_index", type=int, default=None, help="Index of the incident to end processing at (exclusive). Processes all if None.")
    parser.add_argument("--estimate_only", action="store_true", help="Only estimate cost and exit without processing.")


    args = parser.parse_args()

    if not OPENAI_API_KEY:
        print("Error: The OPENAI_API_KEY environment variable is not set.")
        print("Please set it before running the script.")
        print("Example: export OPENAI_API_KEY='your_api_key_here'")
        return

    incidents = load_incidents(args.input_file)
    total_incidents_in_file = len(incidents)

    # Determine narrative field
    narrative_field_name = args.narrative_field
    if not narrative_field_name:
        narrative_field_name = find_narrative_field(incidents[0]) # Use first incident to detect
    print(f"Using narrative field: '{narrative_field_name}'")


    # Determine processing range
    start_idx = args.start_index
    end_idx = args.end_index if args.end_index is not None else total_incidents_in_file

    if not (0 <= start_idx < total_incidents_in_file):
        print(f"Error: start_index ({start_idx}) is out of bounds (0-{total_incidents_in_file-1}).")
        return
    if end_idx <= start_idx or end_idx > total_incidents_in_file:
        print(f"Warning: end_index ({end_idx}) is invalid. Processing from {start_idx} to {total_incidents_in_file-1}.")
        end_idx = total_incidents_in_file

    incidents_to_process_list = incidents[start_idx:end_idx]
    num_incidents_to_process = len(incidents_to_process_list)

    if num_incidents_to_process == 0:
        print("No incidents selected for processing based on start/end index. Exiting.")
        return

    print(f"Will process {num_incidents_to_process} incidents (from index {start_idx} to {end_idx-1}).")

    # Cost Estimation
    # For a more accurate input token estimation, we should calculate it for each specific incident's prompt.
    # Here, we'll calculate for the first incident to process and use it as an average.
    first_narrative_to_process = incidents_to_process_list[0].get(narrative_field_name, {}).get("text", "")
    if isinstance(first_narrative_to_process, list): # Handle cases where narrative might be a list of strings
        first_narrative_to_process = "\n".join(first_narrative_to_process)

    sample_prompt_for_estimation = HFACS_PROMPT_TEMPLATE.format(narrative_text=first_narrative_to_process)
    avg_input_tokens = count_tokens_for_prompt(sample_prompt_for_estimation, MODEL_NAME)
    print(f"Estimated average input tokens per incident (based on first): {avg_input_tokens}")

    estimated_total_cost, est_total_input, est_total_output = estimate_cost(num_incidents_to_process, avg_input_tokens)
    print(f"--- Cost Estimation for {num_incidents_to_process} incidents ---")
    print(f"  Estimated Total Input Tokens: {est_total_input:,}")
    print(f"  Estimated Total Output Tokens (incl. reasoning): {est_total_output:,} (using avg {ESTIMATED_AVERAGE_OUTPUT_TOKENS_PER_CALL} per call)")
    print(f"  Estimated Total Cost: ${estimated_total_cost:.4f}")
    print("--------------------------------------")

    if args.estimate_only:
        print("Exiting after cost estimation as --estimate_only was specified.")
        return

    confirmation = input("Do you want to proceed with processing? (yes/no): ")
    if confirmation.lower() != 'yes':
        print("Processing aborted by user.")
        return

    client = initialize_openai_client()
    
    # Load existing output data if resuming/appending
    if os.path.exists(args.output_file):
        print(f"Loading existing data from '{args.output_file}' to update/append.")
        all_incidents_data = load_incidents(args.output_file)
    else:
        print(f"Output file '{args.output_file}' not found. A new file will be created.")
        all_incidents_data = list(incidents) # Start with a copy of all input incidents

    # Create a dictionary for faster lookups if 'ACN' exists
    # This is important for correctly updating the `all_incidents_data` list
    # which might be from a previous run and already contain some HFACS classifications.
    incident_map = {}
    has_acn = all("ACN" in incident for incident in all_incidents_data) # Check if all incidents have ACN
    
    if has_acn:
        for idx, incident in enumerate(all_incidents_data):
            incident_map[incident["ACN"]] = idx
    else:
        print("Warning: Not all incidents have an 'ACN' field. Updates will be based on list index, which is less robust if input order changes between runs.")


    actual_total_input_tokens_processed = 0
    actual_total_output_tokens_processed = 0

    for current_processing_idx, incident_from_slice in enumerate(incidents_to_process_list):
        # Determine the original index or ACN of the incident
        original_incident_idx = start_idx + current_processing_idx
        incident_id_for_log = incident_from_slice.get("ACN", f"original_index_{original_incident_idx}")

        print(f"\nProcessing Incident {current_processing_idx+1}/{num_incidents_to_process} (ID: {incident_id_for_log}, Original Index: {original_incident_idx})...")

        # Find the incident in our master list `all_incidents_data` to update it
        target_incident_in_master_list = None
        if has_acn and incident_from_slice.get("ACN") in incident_map:
            master_list_idx = incident_map[incident_from_slice["ACN"]]
            target_incident_in_master_list = all_incidents_data[master_list_idx]
        elif not has_acn and original_incident_idx < len(all_incidents_data): # Fallback to index
            target_incident_in_master_list = all_incidents_data[original_incident_idx]
        else:
            print(f"Error: Could not find incident {incident_id_for_log} in master data. Skipping.")
            continue


        narrative_obj = target_incident_in_master_list.get(narrative_field_name)
        narrative = ""
        if isinstance(narrative_obj, dict):
            narrative = narrative_obj.get("text", "")
        elif isinstance(narrative_obj, str): # if narrative_field itself is the string
            narrative = narrative_obj

        if isinstance(narrative, list): # Handle cases where narrative might be a list of strings
            narrative = "\n".join(narrative)

        if not narrative or not narrative.strip():
            print(f"Warning: No narrative found or narrative is empty for incident ID {incident_id_for_log} using field '{narrative_field_name}'. Adding empty classification.")
            target_incident_in_master_list["hfacs_classification"] = []
        else:
            hfacs_data, in_tokens, out_tokens = get_hfacs_classification_from_llm(client, narrative)
            target_incident_in_master_list["hfacs_classification"] = hfacs_data
            actual_total_input_tokens_processed += in_tokens
            actual_total_output_tokens_processed += out_tokens
            print(f"  LLM classification for {incident_id_for_log}: {json.dumps(hfacs_data, indent=1)}")
            print(f"  API reported tokens for this call -> Input: {in_tokens}, Output: {out_tokens}")


        if (current_processing_idx + 1) % 5 == 0 or (current_processing_idx + 1) == num_incidents_to_process:
            print(f"\nSaving progress to '{args.output_file}'...")
            save_incidents(args.output_file, all_incidents_data)

        print(f"Waiting {REQUEST_DELAY_SECONDS}s before next request...")
        time.sleep(REQUEST_DELAY_SECONDS)

    print("\n--- All specified incidents processed. ---")
    # Final save
    print(f"Saving final output to '{args.output_file}'...")
    save_incidents(args.output_file, all_incidents_data)

    # Final Cost Calculation based on actual API usage
    final_input_cost = (actual_total_input_tokens_processed / 1_000_000) * INPUT_COST_PER_MILLION_TOKENS
    final_output_cost = (actual_total_output_tokens_processed / 1_000_000) * OUTPUT_COST_PER_MILLION_TOKENS
    actual_total_cost = final_input_cost + final_output_cost

    print("\n--- Actual Cost Summary ---")
    print(f"  Total Incidents Processed: {num_incidents_to_process}")
    print(f"  Actual Total Input Tokens (sum of tiktoken counts per prompt): {actual_total_input_tokens_processed:,}")
    print(f"  Actual Total Output Tokens (sum from API, incl. reasoning): {actual_total_output_tokens_processed:,}")
    print(f"  Actual Total Cost: ${actual_total_cost:.4f}")
    print("--------------------------")


if __name__ == "__main__":
    main()
