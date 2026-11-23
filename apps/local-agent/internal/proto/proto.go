// Package proto holds the frames of the local-agent protocol. The contract lives in
// packages/shared/protocol/local-agent (fixtures the orchestrator tests load too).
package proto

import (
	"encoding/json"
	"fmt"
)

// Version is the protocol this build speaks; Min is the oldest server protocol it still understands.
const (
	Version = 1
	Min     = 1
)

// Frame is the common envelope: only the fields a type uses are set.
type Frame struct {
	Type string `json:"type"`

	ID    string          `json:"id,omitempty"`
	Op    string          `json:"op,omitempty"`
	Args  json.RawMessage `json:"args,omitempty"`
	OK    *bool           `json:"ok,omitempty"`
	Data  json.RawMessage `json:"data,omitempty"`
	Error string          `json:"error,omitempty"`
	Name  string          `json:"name,omitempty"`

	// hello
	ProtoMin int    `json:"protoMin,omitempty"`
	Proto    int    `json:"proto,omitempty"`
	Version  string `json:"version,omitempty"`
	OS       string `json:"os,omitempty"`
	Arch     string `json:"arch,omitempty"`
	Host     string `json:"host,omitempty"`
	// ConfigRev is the revision of the global rules this agent holds (0 = none): the server pushes `config.set` when it differs
	ConfigRev int `json:"configRev,omitempty"`

	// welcome / refuse
	ServerVersion string `json:"serverVersion,omitempty"`
	PingSec       int    `json:"pingSec,omitempty"`
	Code          string `json:"code,omitempty"`
	Message       string `json:"message,omitempty"`
}

const (
	TypeHello   = "hello"
	TypeWelcome = "welcome"
	TypeRefuse  = "refuse"
	TypePing    = "ping"
	TypePong    = "pong"
	TypeCommand = "command"
	TypeResult  = "result"
	TypeEvent   = "event"
)

// Decode reads one frame and refuses what is not a known type.
func Decode(b []byte) (Frame, error) {
	var f Frame
	if err := json.Unmarshal(b, &f); err != nil {
		return f, fmt.Errorf("bad frame: %w", err)
	}
	switch f.Type {
	case TypeHello, TypeWelcome, TypeRefuse, TypePing, TypePong, TypeCommand, TypeResult, TypeEvent:
		return f, nil
	}
	return f, fmt.Errorf("unknown frame type %q", f.Type)
}

// Encode writes a frame as JSON.
func Encode(f Frame) ([]byte, error) { return json.Marshal(f) }

// Result builds the answer to a command.
func Result(id string, data any, errText string) Frame {
	ok := errText == ""
	f := Frame{Type: TypeResult, ID: id, OK: &ok, Error: errText}
	if ok && data != nil {
		if b, err := json.Marshal(data); err == nil {
			f.Data = b
		}
	}
	return f
}
