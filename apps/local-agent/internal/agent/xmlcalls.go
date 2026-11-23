package agent

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// Some models (Qwen3-Coder among them) write their tool calls as text in their own format instead of the structured field, and a server's parser does not always
// catch it:
//
//	<function=read_file>
//	<parameter=path>
//	main.go
//	</parameter>
//	</function>
//
// extractXMLCalls turns such text into calls (only for tools we know) and returns the text with the calls removed.
var (
	fnRe    = regexp.MustCompile(`(?s)<function=([A-Za-z0-9_.\-]+)>(.*?)</function>`)
	paramRe = regexp.MustCompile(`(?s)<parameter=([A-Za-z0-9_.\-]+)>\n?(.*?)\n?</parameter>`)
	stray   = regexp.MustCompile(`</?tool_call>`)
)

func extractXMLCalls(content string, tools []Tool) ([]toolCall, string) {
	known := map[string]string{}
	for _, t := range tools {
		known[t.Name] = t.Schema
	}
	var calls []toolCall
	for i, m := range fnRe.FindAllStringSubmatch(content, -1) {
		schema, ok := known[m[1]]
		if !ok {
			continue
		}
		types := propertyTypes(schema)
		args := map[string]any{}
		for _, p := range paramRe.FindAllStringSubmatch(m[2], -1) {
			args[p[1]] = coerce(p[2], types[p[1]])
		}
		b, _ := json.Marshal(args)
		c := toolCall{ID: fmt.Sprintf("xml_%d", i), Type: "function"}
		c.Function.Name, c.Function.Arguments = m[1], string(b)
		calls = append(calls, c)
	}
	if len(calls) == 0 {
		return nil, content
	}
	rest := stray.ReplaceAllString(fnRe.ReplaceAllString(content, ""), "")
	return calls, strings.TrimSpace(rest)
}

func propertyTypes(schema string) map[string]string {
	var s struct {
		Properties map[string]struct {
			Type string `json:"type"`
		} `json:"properties"`
	}
	_ = json.Unmarshal([]byte(schema), &s)
	out := map[string]string{}
	for k, v := range s.Properties {
		out[k] = v.Type
	}
	return out
}

func coerce(raw, typ string) any {
	switch typ {
	case "integer":
		if n, err := strconv.Atoi(strings.TrimSpace(raw)); err == nil {
			return n
		}
	case "boolean":
		if b, err := strconv.ParseBool(strings.TrimSpace(raw)); err == nil {
			return b
		}
	case "array", "object":
		var v any
		if json.Unmarshal([]byte(raw), &v) == nil {
			return v
		}
	}
	return raw
}
