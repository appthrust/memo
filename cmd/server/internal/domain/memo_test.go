package domain

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestExcerpt(t *testing.T) {
	require.Equal(t, "Heading bold italic code quote item link image", Excerpt("# Heading\n**bold** _italic_ `code` > quote - item [link](https://example.test) ![image](image.png)"))
	require.Equal(t, strings.Repeat("あ", 160), Excerpt(strings.Repeat("あ", 170)))
	require.Empty(t, Excerpt("  \n\t"))
	require.Equal(t, "before alert(1) after", Excerpt("before <script>alert(1)</script> after"))
}
