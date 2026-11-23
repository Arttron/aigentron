package proto

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

const fixtures = "../../../../packages/shared/protocol/local-agent"

// Every fixture must decode, and re-encoding must give the same JSON (no field is lost or renamed).
func TestFixturesRoundTrip(t *testing.T) {
	files, err := filepath.Glob(filepath.Join(fixtures, "*.json"))
	if err != nil || len(files) == 0 {
		t.Fatalf("no fixtures found in %s: %v", fixtures, err)
	}
	for _, file := range files {
		raw, _ := os.ReadFile(file)
		f, err := Decode(raw)
		if err != nil {
			t.Fatalf("%s: %v", file, err)
		}
		out, err := Encode(f)
		if err != nil {
			t.Fatalf("%s: %v", file, err)
		}
		var a, b any
		_ = json.Unmarshal(raw, &a)
		_ = json.Unmarshal(out, &b)
		if !reflect.DeepEqual(a, b) {
			t.Errorf("%s: round trip changed the frame\n in: %s\nout: %s", filepath.Base(file), raw, out)
		}
	}
}

func TestDecodeRefusesUnknown(t *testing.T) {
	if _, err := Decode([]byte(`{"type":"nope"}`)); err == nil {
		t.Fatal("unknown type accepted")
	}
	if _, err := Decode([]byte(`not json`)); err == nil {
		t.Fatal("garbage accepted")
	}
}

func TestResult(t *testing.T) {
	if f := Result("1", map[string]int{"a": 1}, ""); f.OK == nil || !*f.OK || string(f.Data) != `{"a":1}` {
		t.Fatalf("ok result wrong: %+v", f)
	}
	if f := Result("1", nil, "boom"); f.OK == nil || *f.OK || f.Error != "boom" {
		t.Fatalf("error result wrong: %+v", f)
	}
}
