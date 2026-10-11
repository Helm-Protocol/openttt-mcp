CLANG ?= clang
MULTIARCH := $(shell $(CC) -dumpmachine)
CFLAGS ?= -O2 -g -target bpf -I/usr/include/$(MULTIARCH)

all: tttps_xdp.o

tttps_xdp.o: tttps_xdp.c
	$(CLANG) $(CFLAGS) -c $< -o $@

clean:
	rm -f tttps_xdp.o
