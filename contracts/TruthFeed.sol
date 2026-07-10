// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title TruthFeed — on-chain, TEE-attested claim / news verifier on Ritual Chain
/// @notice A claim is submitted, real-world evidence is fetched with the HTTP
///         precompile (0x0801), and a verdict is produced by the LLM precompile
///         (0x0802). Both run inside a TEE and their outputs are stored on-chain,
///         so the verdict cannot be silently forged or re-biased.
contract TruthFeed {
    // ----- Ritual precompiles (fixed addresses on chain 1979) -----
    address internal constant HTTP_PRECOMPILE = 0x0000000000000000000000000000000000000801;
    address internal constant LLM_PRECOMPILE  = 0x0000000000000000000000000000000000000802;

    // convoHistory StorageRef is the 30th LLM ABI field: (platform, path, key_ref).
    // Empty triple = no persisted history, which is what we want per verification.
    struct StorageRef {
        string platform;
        string path;
        string keyRef;
    }

    enum Stage {
        None,       // 0 - does not exist
        Submitted,  // 1 - claim recorded, no evidence yet
        Evidence,   // 2 - HTTP evidence fetched
        Judged      // 3 - LLM verdict stored
    }

    struct Claim {
        address author;
        Stage   stage;
        uint16  httpStatus;   // status code from the evidence fetch
        bool    llmError;     // true if the LLM executor returned an error envelope
        uint64  createdAt;
        uint64  judgedAt;
        string  text;         // the claim being checked
        string  sourceUrl;    // where evidence was pulled from
        string  evidence;     // raw response body from the HTTP precompile (<= 5KB)
        string  verdict;      // attested model output (JSON string) — or error message
    }

    uint256 public claimCount;
    mapping(uint256 => Claim) public claims;

    event ClaimSubmitted(uint256 indexed id, address indexed author, string text);
    event EvidenceFetched(uint256 indexed id, uint16 status, uint256 length);
    event ClaimJudged(uint256 indexed id, bool llmError, string verdict);

    // ---------------------------------------------------------------------
    // 1. Submit a claim (plain storage tx — no async, no fees)
    // ---------------------------------------------------------------------
    function submitClaim(string calldata text) external returns (uint256 id) {
        require(bytes(text).length > 0, "empty claim");
        id = ++claimCount;
        Claim storage c = claims[id];
        c.author = msg.sender;
        c.stage = Stage.Submitted;
        c.createdAt = uint64(block.timestamp);
        c.text = text;
        emit ClaimSubmitted(id, msg.sender, text);
    }

    // ---------------------------------------------------------------------
    // 2. Fetch evidence via the HTTP precompile (ONE short-running async call)
    //    `executor` must be a live HTTP_CALL (capability 0) executor teeAddress.
    //    `url` is built off-chain from the claim (kept keyless: public sources).
    // ---------------------------------------------------------------------
    function fetchEvidence(
        uint256 id,
        address executor,
        string calldata url,
        string[] calldata headerKeys,
        string[] calldata headerValues,
        uint256 ttl
    ) external {
        Claim storage c = claims[id];
        require(c.stage == Stage.Submitted || c.stage == Stage.Evidence, "bad stage");

        // HTTP precompile input — all 13 fields, GET request, no secrets.
        bytes memory input = abi.encode(
            executor,          // 1  executor teeAddress
            new bytes[](0),    // 2  encryptedSecrets
            ttl,               // 3  ttl (blocks, 1..500)
            new bytes[](0),    // 4  secretSignatures
            bytes(""),         // 5  userPublicKey
            url,               // 6  url
            uint8(1),          // 7  method: 1 = GET
            headerKeys,        // 8  header keys (e.g. User-Agent)
            headerValues,      // 9  header values
            bytes(""),         // 10 body
            uint256(0),        // 11 dkmsKeyIndex (disabled)
            uint8(0),          // 12 dkmsKeyFormat (disabled)
            false              // 13 piiEnabled
        );

        (bool ok, bytes memory raw) = HTTP_PRECOMPILE.call(input);
        require(ok, "http precompile call failed");

        // Short-running async envelope: (bytes simmedInput, bytes actualOutput)
        (, bytes memory actual) = abi.decode(raw, (bytes, bytes));
        (uint16 status, , , bytes memory body, string memory errorMessage) =
            abi.decode(actual, (uint16, string[], string[], bytes, string));
        require(bytes(errorMessage).length == 0, errorMessage);

        c.httpStatus = status;
        c.sourceUrl = url;
        c.evidence = string(body);
        c.stage = Stage.Evidence;
        emit EvidenceFetched(id, status, body.length);
    }

    // ---------------------------------------------------------------------
    // 3. Judge the claim via the LLM precompile (ONE short-running async call)
    //    `messagesJson` is the OpenAI-format prompt built off-chain (safe JSON
    //    escaping of the stored claim + evidence). `executor` is a live LLM
    //    (capability 1) teeAddress.
    // ---------------------------------------------------------------------
    function judgeClaim(
        uint256 id,
        address executor,
        string calldata messagesJson,
        uint256 ttl,
        int256 maxCompletionTokens
    ) external {
        Claim storage c = claims[id];
        require(c.stage == Stage.Evidence, "fetch evidence first");

        bytes memory input = _encodeLLM(executor, ttl, messagesJson, maxCompletionTokens);

        (bool ok, bytes memory raw) = LLM_PRECOMPILE.call(input);
        require(ok, "llm precompile call failed");

        (, bytes memory actual) = abi.decode(raw, (bytes, bytes));
        (bool hasError, bytes memory completionData, , string memory errorMessage, ) =
            abi.decode(actual, (bool, bytes, bytes, string, StorageRef));

        c.llmError = hasError;
        c.verdict = hasError ? errorMessage : _extractContent(completionData);
        c.stage = Stage.Judged;
        c.judgedAt = uint64(block.timestamp);
        emit ClaimJudged(id, hasError, c.verdict);
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    /// @dev Encode the 30-field LLM request. GLM-4.7-FP8 is a reasoning model,
    ///      so maxCompletionTokens should be >= 4096 and ttl >= 60.
    function _encodeLLM(
        address executor,
        uint256 ttl,
        string memory messagesJson,
        int256 maxCompletionTokens
    ) internal pure returns (bytes memory) {
        return abi.encode(
            executor,                 // 1  executor
            new bytes[](0),           // 2  encryptedSecrets
            ttl,                      // 3  ttl
            new bytes[](0),           // 4  secretSignatures
            bytes(""),                // 5  userPublicKey
            messagesJson,             // 6  messagesJson
            "zai-org/GLM-4.7-FP8",    // 7  model
            int256(0),                // 8  frequencyPenalty
            "",                       // 9  logitBiasJson
            false,                    // 10 logprobs
            maxCompletionTokens,      // 11 maxCompletionTokens
            "",                       // 12 metadataJson
            "",                       // 13 modalitiesJson
            uint256(1),               // 14 n
            true,                     // 15 parallelToolCalls
            int256(0),                // 16 presencePenalty
            "medium",                 // 17 reasoningEffort
            bytes(""),                // 18 responseFormatData
            int256(-1),               // 19 seed (null)
            "auto",                   // 20 serviceTier
            "",                       // 21 stopJson
            false,                    // 22 stream
            int256(100),              // 23 temperature (0.1 x1000 — deterministic-ish)
            bytes(""),                // 24 toolChoiceData
            bytes(""),                // 25 toolsData
            int256(-1),               // 26 topLogprobs (null)
            int256(1000),             // 27 topP (1.0 x1000)
            "",                       // 28 user
            false,                    // 29 piiEnabled
            StorageRef("", "", "")    // 30 convoHistory (empty = no persisted history)
        );
    }

    /// @dev Walk the ABI-encoded CompletionData to pull out choices[0].message.content.
    function _extractContent(bytes memory completionData) internal pure returns (string memory) {
        ( , , , , , , uint256 choicesCount, bytes[] memory choicesData, ) = abi.decode(
            completionData,
            (string, string, uint256, string, string, string, uint256, bytes[], bytes)
        );
        if (choicesCount == 0 || choicesData.length == 0) return "";

        ( , , bytes memory messageData) =
            abi.decode(choicesData[0], (uint256, string, bytes));
        ( , string memory content, , , ) =
            abi.decode(messageData, (string, string, string, uint256, bytes[]));
        return content;
    }

    // ---------------------------------------------------------------------
    // Views for the frontend feed
    // ---------------------------------------------------------------------
    function getClaim(uint256 id)
        external
        view
        returns (
            address author,
            Stage stage,
            uint16 httpStatus,
            bool llmError,
            uint64 createdAt,
            uint64 judgedAt,
            string memory text,
            string memory sourceUrl,
            string memory evidence,
            string memory verdict
        )
    {
        Claim storage c = claims[id];
        return (
            c.author, c.stage, c.httpStatus, c.llmError,
            c.createdAt, c.judgedAt, c.text, c.sourceUrl, c.evidence, c.verdict
        );
    }
}
