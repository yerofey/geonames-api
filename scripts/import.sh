#!/bin/bash

# GeoNames API Import Script
# This script helps import data into the GeoNames API service

# Load configuration
CONFIG_FILE="../.env"
if [ ! -f "$CONFIG_FILE" ]; then
    echo "Error: Configuration file not found at $CONFIG_FILE"
    echo "Please copy .env.example to .env and update the values"
    exit 1
fi

source "$CONFIG_FILE"

# Validate configuration
if [ -z "$WORKER_URL" ] || [ "$WORKER_URL" = "https://your-worker.workers.dev" ]; then
    echo "Error: Please set WORKER_URL in $CONFIG_FILE"
    exit 1
fi

if [ -z "$ADMIN_SECRET_KEY" ] || [ "$ADMIN_SECRET_KEY" = "your-secret-key" ]; then
    echo "Error: Please set ADMIN_SECRET_KEY in $CONFIG_FILE"
    exit 1
fi

# Configuration
BATCH_SIZE=50
CONCURRENT_REQUESTS=5
POPULATION_THRESHOLD=5000

# Parse command line arguments
RETRY_FAILED=false
CLEAN_START=false
MANUAL_OFFSETS=()
MANUAL_MODE=false

print_usage() {
    echo "Usage: $0 [options]"
    echo "Options:"
    echo "  --retry                  Retry failed imports"
    echo "  --clean                  Start fresh (clear existing data)"
    echo "  --threshold <number>     Set minimum city population (default: 5000)"
    echo "  --batch-size <number>    Records per batch (default: 50)"
    echo "  --concurrent <number>    Concurrent requests (default: 5)"
    echo "  --offset <number>        Process specific offset"
    echo "  --range <start>..<end>   Process range of offsets"
    echo "  --offsets <list>         Process comma-separated list of offsets"
    echo
    echo "Examples:"
    echo "  $0 --threshold 15000                    # Run with population threshold 15000"
    echo "  $0 --offset 1000                        # Process offset 1000"
    echo "  $0 --range 1000..2000                   # Process offsets 1000 to 2000"
    echo "  $0 --offsets 1000,1500,2000            # Process specific offsets"
    echo "  $0 --threshold 5000 --offset 1000       # Process offset 1000 with threshold 5000"
}

while [[ "$#" -gt 0 ]]; do
    case $1 in
        --retry) RETRY_FAILED=true ;;
        --clean) CLEAN_START=true ;;
        --threshold) POPULATION_THRESHOLD="$2"; shift ;;
        --batch-size) BATCH_SIZE="$2"; shift ;;
        --concurrent) CONCURRENT_REQUESTS="$2"; shift ;;
        --offset)
            MANUAL_OFFSETS+=($2)
            MANUAL_MODE=true
            shift
            ;;
        --range)
            range=$2
            start=${range%%..*}
            end=${range#*..}
            if [[ ! "$start" =~ ^[0-9]+$ ]] || [[ ! "$end" =~ ^[0-9]+$ ]]; then
                echo "Error: Invalid range format. Use: start..end"
                exit 1
            fi
            for ((i=start; i<=end; i+=BATCH_SIZE)); do
                MANUAL_OFFSETS+=($i)
            done
            MANUAL_MODE=true
            shift
            ;;
        --offsets)
            IFS=',' read -ra OFFS <<< "$2"
            for i in "${OFFS[@]}"; do
                if [[ ! "$i" =~ ^[0-9]+$ ]]; then
                    echo "Error: Invalid offset: $i"
                    exit 1
                fi
                MANUAL_OFFSETS+=($i)
            done
            MANUAL_MODE=true
            shift
            ;;
        --help|-h)
            print_usage
            exit 0
            ;;
        *)
            echo "Unknown parameter: $1"
            print_usage
            exit 1
            ;;
    esac
    shift
done

# Function to make an import request
make_import_request() {
    local offset=$1
    local clean_start=${2:-false}
    local response
    response=$(curl -s -X POST "${WORKER_URL}/trigger-scrape" \
        -H "Authorization: Bearer ${ADMIN_SECRET_KEY}" \
        -H "Content-Type: application/json" \
        -d "{
            \"cityPopulationThreshold\": ${POPULATION_THRESHOLD},
            \"offset\": ${offset},
            \"limit\": ${BATCH_SIZE},
            \"cleanStart\": ${clean_start}
        }")
    echo "Offset ${offset}: ${response}"
    
    # Check if the request was successful
    if ! echo "${response}" | jq -e '.status' > /dev/null 2>&1; then
        echo "Error at offset ${offset}: Failed to parse response"
        return 1
    fi
}

# Function to get import status
get_import_status() {
    local status_response
    status_response=$(curl -s "${WORKER_URL}/import-status" \
        -H "Authorization: Bearer ${ADMIN_SECRET_KEY}")
    
    # Check if the response is valid JSON
    if ! echo "${status_response}" | jq -e '.' > /dev/null 2>&1; then
        echo "Error: Invalid status response"
        return 1
    fi
    
    echo "${status_response}"
}

# Function to get total cities count
get_cities_count() {
    local count_response
    count_response=$(curl -s "${WORKER_URL}/cities/count" \
        -H "Authorization: Bearer ${ADMIN_SECRET_KEY}" \
        -H "Content-Type: application/json")
    
    # Extract count from response
    if ! echo "${count_response}" | jq -e '.count' > /dev/null 2>&1; then
        echo "Error: Failed to get cities count"
        return 1
    fi
    
    echo "${count_response}" | jq -r '.count'
}

# Function to retry failed offsets
retry_failed_offsets() {
    local failed_offsets=("$@")
    echo "Retrying failed offsets: ${failed_offsets[*]}"
    
    for offset in "${failed_offsets[@]}"; do
        echo "Retrying offset ${offset}..."
        make_import_request "$offset" false
        sleep 2
    done
}

# Print configuration
echo "Configuration:"
echo "- Worker URL: ${WORKER_URL}"
echo "- Population threshold: ${POPULATION_THRESHOLD}"
echo "- Batch size: ${BATCH_SIZE}"
echo "- Concurrent requests: ${CONCURRENT_REQUESTS}"
echo "- Clean start: ${CLEAN_START}"
if [ "$MANUAL_MODE" = true ]; then
    echo "- Manual offsets: ${MANUAL_OFFSETS[*]}"
elif [ "$RETRY_FAILED" = true ]; then
    echo "- Mode: Retry failed offsets"
else
    echo "- Mode: Full import"
fi

# Check if we should retry failed offsets from previous import
if [ "$RETRY_FAILED" = true ]; then
    echo "Checking previous import status..."
    IMPORT_STATUS=$(get_import_status)
    if [ $? -eq 0 ]; then
        STATUS=$(echo "${IMPORT_STATUS}" | jq -r '.status')
        if [ "$STATUS" = "failed" ]; then
            echo "Found failed import, retrying failed offsets..."
            FAILED_OFFSETS=($(echo "${IMPORT_STATUS}" | jq -r '.failedOffsets[]'))
            if [ ${#FAILED_OFFSETS[@]} -gt 0 ]; then
                retry_failed_offsets "${FAILED_OFFSETS[@]}"
                exit 0
            fi
        fi
    fi
fi

# If in manual mode, process specified offsets
if [ "$MANUAL_MODE" = true ]; then
    echo "Processing specified offsets: ${MANUAL_OFFSETS[*]}"
    FAILED_OFFSETS=()
    
    # Process offsets in parallel batches
    for ((i = 0; i < ${#MANUAL_OFFSETS[@]}; i += CONCURRENT_REQUESTS)); do
        PIDS=()
        CURRENT_OFFSETS=()
        
        # Launch concurrent requests
        for ((j = 0; j < CONCURRENT_REQUESTS && (i + j) < ${#MANUAL_OFFSETS[@]}; j++)); do
            OFFSET=${MANUAL_OFFSETS[$((i + j))]}
            CURRENT_OFFSETS+=($OFFSET)
            make_import_request $OFFSET "$CLEAN_START" &
            PIDS+=($!)
        done
        
        # Wait for all concurrent requests to complete
        for idx in "${!PIDS[@]}"; do
            if ! wait ${PIDS[$idx]}; then
                FAILED_OFFSETS+=(${CURRENT_OFFSETS[$idx]})
            fi
        done
        
        echo "Completed batch $((i / CONCURRENT_REQUESTS + 1)) of $(((${#MANUAL_OFFSETS[@]} + CONCURRENT_REQUESTS - 1) / CONCURRENT_REQUESTS))"
        sleep 2
    done
    
    # Report results
    echo "Manual import completed!"
    if [ ${#FAILED_OFFSETS[@]} -gt 0 ]; then
        echo "Failed offsets: ${FAILED_OFFSETS[*]}"
        echo "To retry failed offsets, run: $0 --offsets ${FAILED_OFFSETS[*]}"
    fi
    
    # Final status check
    echo "Getting final import status..."
    FINAL_STATUS=$(get_import_status)
    echo "${FINAL_STATUS}" | jq '.'
    
    # Check total cities count
    echo "Checking total cities count..."
    TOTAL_CITIES=$(get_cities_count)
    if [ $? -eq 0 ]; then
        echo "Total cities in database: ${TOTAL_CITIES}"
        if [ "$TOTAL_CITIES" -lt 9000 ]; then
            echo "Warning: The number of cities seems low. Expected more than 9,000 cities."
            echo "Consider:"
            echo "1. Running with --clean to start fresh"
            echo "2. Checking for failed offsets and retrying them"
            echo "3. Verifying the population threshold settings"
        fi
    fi
    exit 0
fi

# Initialize import and get total lines
echo "Initializing import..."
make_import_request 0 "$CLEAN_START"
echo "Waiting for initial data download and processing (15 seconds)..."
sleep 15

# Keep trying to get total lines
MAX_RETRIES=10
RETRY_COUNT=0
TOTAL_LINES=""

while [ -z "$TOTAL_LINES" ] && [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
    echo "Getting import status (attempt $((RETRY_COUNT + 1))/${MAX_RETRIES})..."
    IMPORT_STATUS=$(get_import_status)
    
    if [ $? -eq 0 ]; then
        TOTAL_LINES=$(echo "${IMPORT_STATUS}" | jq -r '.totalLines // empty')
        if [ -n "$TOTAL_LINES" ]; then
            break
        fi
    fi
    
    RETRY_COUNT=$((RETRY_COUNT + 1))
    echo "Waiting 5 seconds before next attempt..."
    sleep 5
done

if [ -z "$TOTAL_LINES" ]; then
    echo "Error: Failed to get total lines after ${MAX_RETRIES} attempts"
    echo "Last status response:"
    get_import_status | jq '.'
    exit 1
fi

echo "Total lines to process: ${TOTAL_LINES}"

# Calculate number of batches
TOTAL_BATCHES=$((TOTAL_LINES / BATCH_SIZE))
if [ $((TOTAL_LINES % BATCH_SIZE)) -ne 0 ]; then
    TOTAL_BATCHES=$((TOTAL_BATCHES + 1))
fi

echo "Total batches to process: ${TOTAL_BATCHES}"
echo "Processing with ${CONCURRENT_REQUESTS} concurrent requests..."

# Process batches with parallel requests
FAILED_OFFSETS=()

for ((i = 0; i < TOTAL_BATCHES; i += CONCURRENT_REQUESTS)); do
    PIDS=()
    OFFSETS=()
    
    # Launch concurrent requests
    for ((j = 0; j < CONCURRENT_REQUESTS && (i + j) < TOTAL_BATCHES; j++)); do
        OFFSET=$(((i + j) * BATCH_SIZE))
        OFFSETS+=($OFFSET)
        make_import_request $OFFSET false &
        PIDS+=($!)
    done
    
    # Wait for all concurrent requests to complete
    for idx in "${!PIDS[@]}"; do
        if ! wait ${PIDS[$idx]}; then
            FAILED_OFFSETS+=(${OFFSETS[$idx]})
        fi
    done
    
    echo "Completed batch group $((i / CONCURRENT_REQUESTS + 1)) of $((TOTAL_BATCHES / CONCURRENT_REQUESTS + 1))"
    
    # Small delay to prevent overwhelming the worker
    sleep 2
done

# Report results
echo "Import process completed!"
if [ ${#FAILED_OFFSETS[@]} -gt 0 ]; then
    echo "Failed offsets: ${FAILED_OFFSETS[*]}"
    echo "To retry failed offsets, run: $0 --retry"
fi

# Final status check
echo "Getting final import status..."
FINAL_STATUS=$(get_import_status)
if [ $? -eq 0 ]; then
    echo "${FINAL_STATUS}" | jq '.'
else
    echo "Failed to get final status"
fi

# Check total cities count
echo "Checking total cities count..."
TOTAL_CITIES=$(get_cities_count)
if [ $? -eq 0 ]; then
    echo "Total cities in database: ${TOTAL_CITIES}"
    if [ "$TOTAL_CITIES" -lt 9000 ]; then
        echo "Warning: The number of cities seems low. Expected more than 9,000 cities."
        echo "Consider:"
        echo "1. Running with --clean to start fresh"
        echo "2. Checking for failed offsets and retrying them"
        echo "3. Verifying the population threshold settings"
    fi
fi 