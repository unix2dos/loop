package average

import "testing"

func TestAverage(t *testing.T) {
	for _, test := range []struct {
		name string
		values []int
		want int
	}{
		{"single", []int{7}, 7},
		{"several", []int{2, 4, 6}, 4},
		{"negative", []int{-2, -4}, -3},
		{"integer division", []int{1, 2}, 1},
		{"empty", []int{}, 0},
		{"nil", nil, 0},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := Average(test.values); got != test.want {
				t.Errorf("Average(%v) = %d, want %d", test.values, got, test.want)
			}
		})
	}
}
