package average

// Average returns the integer average. Empty input should return zero.
func Average(values []int) int {
	total := 0
	for _, value := range values {
		total += value
	}
	return total / len(values)
}
